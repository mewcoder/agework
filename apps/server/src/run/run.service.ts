import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnApplicationBootstrap,
} from "@nestjs/common";
import { generateId } from "@agework/shared";
import type { Response } from "express";
import { swallow } from "../common/swallow";
import type { RuntimeHostExecution } from "@agework/shared/protocol";
import { RunRepository } from "./run.repository";
import { LiveRunRegistry } from "./live-run/live-run.registry";
import { RUNTIME_HOST_EXECUTION } from "../runtime-host/runtime-host.types";
import { RuntimeHostService } from "../runtime-host/runtime-host.service";
import { type IncompleteMessageReason } from "./upstream/assistant-message.aggregator";
import { RunEventService } from "../run-event/run-event.service";
import { RunStatusService } from "./status/run-status.service";
import type { StartRunInput } from "./run.types";
import { RunStream } from "./streaming/run.stream";
import { RunLauncher } from "./launch/run.launcher";
import { RunRecoveryService } from "./recovery/run-recovery.service";

@Injectable()
export class RunService implements OnApplicationBootstrap {
  private readonly logger = new Logger(RunService.name);
  private recoveryStarted = false;

  constructor(
    private readonly runRepository: RunRepository,
    private readonly liveRuns: LiveRunRegistry,
    @Inject(RUNTIME_HOST_EXECUTION)
    private readonly runtimeHost: RuntimeHostExecution,
    private readonly runtimeHosts: RuntimeHostService,
    private readonly runEvents: RunEventService,
    private readonly runStatusService: RunStatusService,
    private readonly runLauncher: RunLauncher,
    private readonly runRecovery: RunRecoveryService
  ) {}

  /**
   * 应用启动后触发一次性重启恢复：扫描中断的 active run，标记为 error
   * 并通过 ConversationService 回写会话状态。
   */
  async onApplicationBootstrap(): Promise<void> {
    if (this.recoveryStarted) return;
    this.recoveryStarted = true;
    await this.runRecovery.failInterruptedRuns();
  }

  /** registered Host 重连时同步对账现场 run；失败必须向协调器传播。 */
  reconcileRuntimeHostRuns(runtimeHostId: string): Promise<void> {
    return this.runRecovery.reconcileRuntimeHost(runtimeHostId);
  }

  /** 管理端：分页查询 run 列表。 */
  async listForAdmin(params: { status?: string; take: number; skip: number }) {
    const { runs, total } = await this.runRepository.listForAdmin(params);
    return {
      list: runs.map(toAdminRunListItem),
      total,
      pageNo: params.skip / params.take + 1,
      pageSize: params.take,
    };
  }

  /** 管理端：单个 run 详情；worker 快照经执行面契约的观测口补齐。 */
  async getDetailForAdmin(id: string) {
    const row = await this.runRepository.findAdminDetail(id);
    if (!row) {
      throw new NotFoundException(`Run ${id} 不存在`);
    }
    const { list: workers } = await this.runtimeHosts.listWorkersForAdmin();
    const worker = workers.find((w) => w.runIds.includes(id)) ?? null;
    return { ...toAdminRunDetail(row), worker };
  }

  /** 管理端：按 run 查询事件（编排 run-events 的读路径）。 */
  listEventsForAdmin(params: Parameters<RunEventService["listForAdmin"]>[0]) {
    return this.runEvents.listForAdmin(params);
  }

  /**
   * 管理端：按 run 查询本地 raw/agui JSONL 流水。run 没有对应 conversation 时
   * 返回空列表(不是错误,只是从未 trace 过或已被清理)。
   */
  async listRawEventsForAdmin(params: {
    runId: string;
    channel?: Parameters<RunEventService["listRawForAdmin"]>[0]["channel"];
    take: number;
    skip: number;
  }) {
    const conversationId = await this.runRepository.findConversationId(
      params.runId
    );
    if (!conversationId) {
      return { list: [], total: 0, pageNo: 1, pageSize: params.take };
    }
    return this.runEvents.listRawForAdmin({ ...params, conversationId });
  }

  /**
   * workspace 删除级联：停止该 workspace 下所有活跃 run（best-effort，逐个吞错）。
   * 由 RunWorkspaceListener 监听 WORKSPACE_DELETED 触发。
   */
  async stopForWorkspace(workspaceId: string): Promise<void> {
    const conversationIds =
      await this.runRepository.findActiveConversationIdsForWorkspace(
        workspaceId
      );
    await Promise.all(
      conversationIds.map((conversationId) =>
        this.stop(conversationId).catch((err) => {
          this.logger.warn(
            `stop run for conversation ${conversationId} failed: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        })
      )
    );
  }

  /**
   * user 停用/删除级联：停止该 user 名下所有活跃 run（best-effort，逐个吞错）。
   * 由 RunUserListener 监听 USER_DISABLED / USER_DELETED 触发，先于 releaseResources
   * 执行，保证 run 以 cancelled 而非 worker-lost error 收场。
   */
  async stopForUser(userId: string): Promise<void> {
    const conversationIds =
      await this.runRepository.findActiveConversationIdsForUser(userId);
    await Promise.all(
      conversationIds.map((conversationId) =>
        this.stop(conversationId).catch((err) => {
          this.logger.warn(
            `stop run for conversation ${conversationId} failed: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        })
      )
    );
  }

  /**
   * 启动一次 run。出站启动准备（placement / RunConfig / 落库 / 拉起 worker / 注册 handle）
   * 全部委托给 RunLauncher；RunService 只注入「让位旧 run」端口，供 user_steered 时停掉活跃 run。
   */
  async start(input: StartRunInput): Promise<void> {
    await this.runLauncher.launch(input, {
      stopActiveRun: (conversationId, options) =>
        this.stopWithResult(conversationId, options),
    });
  }

  /**
   * Interrupt 答复续接（terminal model）：校验 resume[] 后先把新 SSE 附接到
   * 活跃 run 的 handle（事件模式，保证续接段的 RUN_STARTED 不漏），再把
   * provider-agnostic payload 经 approval_resolved 命令下发给 worker；
   * adapter 自解 payload（【决策2】），解开挂起后以 resumeRunId 发 RUN_STARTED，
   * 后续事件流入本次 res。
   * 无活跃 run 或不在待答状态时抛 Conflict，前端 invalidate 后按最新状态走。
   */
  async resumeWithAnswers(input: {
    conversationId: string;
    resumeRunId: string;
    resume: unknown;
    res: Response;
  }): Promise<void> {
    const { conversationId, resumeRunId, res } = input;
    const { status, payload } = extractResumePayload(input.resume);

    const activeRun =
      await this.runRepository.findActiveByConversationId(conversationId);
    const handle = activeRun ? this.liveRuns.get(activeRun.id) : undefined;
    if (!handle || activeRun?.status !== "requires_action") {
      throw new ConflictException(
        `No pending question for conversation: ${conversationId}`
      );
    }

    handle.stream.replace(res, "events");
    handle.stream.onClose(() => {
      const current = this.liveRuns.get(handle.runId);
      if (current?.stream.isAttachedTo(res)) {
        current.stream.detach(res);
      }
    });

    const runId = handle.runtimeHandle.runId;
    await this.runtimeHost.command({
      runtimeHostId: handle.runtimeHandle.runtimeHostId,
      payload: {
        type: "approval_resolved",
        commandId: generateId(),
        runId,
        conversationId,
        payload: status === "cancelled" ? { status: "cancelled" } : payload,
        resumeRunId,
      },
    });
    this.runEvents
      .append(this.runEvents.permissionResolved({ runId }))
      .catch(
        swallow(this.logger, `record permission resolved for run ${runId}`)
      );
  }

  /**
   * 刷新网页后续接一个进行中的 run：把新的 SSE response 接到活跃 run 的 handle 上，
   * 以「累积快照」模式推送。前端 ThreadHistoryAdapter.resume
   * 直接 yield 这些快照，实现刷新后实时续接。
   *
   * 处理三种情况：
   *  - 活跃 run 且 status=running：补发当前累积快照，替换 res，后续事件转快照推送。
   *  - 活跃 run 但 status=requires_action：首版不接 stream，返回 409 让前端走正常 load+审批。
   *  - 无活跃 run / 无内存 handle（已结束）：发一个终态 complete 快照并 end，
   *    让前端 resume 流正常收尾，不卡在 running。
   */
  async resume(conversationId: string, res: Response): Promise<void> {
    const activeRunRecord =
      await this.runRepository.findActiveByConversationId(conversationId);
    const handle = activeRunRecord
      ? this.liveRuns.get(activeRunRecord.id)
      : undefined;

    // run 已结束 / 无内存 handle：发终态快照收尾
    if (!handle) {
      const stream = new RunStream(res);
      stream.writeSnapshot({
        content: [],
        status: { type: "complete", reason: "unknown" },
      });
      stream.end();
      return;
    }

    // Terminal model：问答挂起期间没有可续接的 AG-UI run，前端也不会对
    // requires_action 发起 resume。防御性兜底：发当前累积快照
    // （requires-action/interrupt）后收尾，前端按待答 UI 展示。
    if (activeRunRecord?.status === "requires_action") {
      const stream = new RunStream(res);
      stream.writeSnapshot(handle.aggregator.build(false, "streaming"));
      stream.end();
      return;
    }

    // 接管 SSE 连接：原连接（刷新前）已断，单订阅直接替换
    // 守卫：若旧连接尚未关闭（close 事件未触发的 race condition），主动 end 防连接泄漏
    handle.stream.replace(res, "snapshots");

    // 补发当前累积快照（resume 流的起点，含已输出的全部内容）
    handle.stream.writeSnapshot(handle.aggregator.build(false, "streaming"));

    handle.stream.onClose(() => {
      // 连接断开只清引用，不取消 run（与正常 run 的 res.on close 一致）
      const current = this.liveRuns.get(handle.runId);
      if (current?.stream.isAttachedTo(res)) {
        current.stream.detach(res);
      }
    });
  }

  /**
   * 停止指定 conversation 的活跃 run。
   * @returns 是否存在活跃的 in-memory run handle 并已下发取消命令。
   */
  async stop(
    conversationId: string,
    options?: { reason?: IncompleteMessageReason; endResponse?: boolean }
  ): Promise<boolean> {
    return (await this.stopWithResult(conversationId, options)).hadHandle;
  }

  /** steering 额外需要旧 runId，才能原子交接 Conversation 投影所有权。 */
  private async stopWithResult(
    conversationId: string,
    options?: { reason?: IncompleteMessageReason; endResponse?: boolean }
  ): Promise<{ runId?: string; hadHandle: boolean }> {
    const activeRunRecord =
      await this.runRepository.findActiveByConversationId(conversationId);
    const handle = activeRunRecord
      ? this.liveRuns.get(activeRunRecord.id)
      : undefined;
    if (!handle) {
      // No in-memory handle — clean up stale state
      if (activeRunRecord) {
        await this.runStatusService.markCancelledWithoutHandle({
          runId: activeRunRecord.id,
          conversationId,
        });
      } else {
        // 无活跃 Run 行时收敛遗留的 running 投影(CAS 守卫,存在非终态 Run 则不动),
        // 让用户的停止操作可以在运行期修复卡死会话,不必等服务重启对账。
        await this.runStatusService.reconcileConversationRunStatus({
          conversationId,
          runStatus: "idle",
        });
      }
      return { runId: activeRunRecord?.id, hadHandle: false };
    }
    handle.stopRequested = true;
    handle.stopReason = options?.reason;
    if (activeRunRecord) {
      await this.runStatusService.markCancelRequested(
        activeRunRecord.id,
        options?.reason
      );
    }
    await this.runtimeHost.command({
      runtimeHostId: handle.runtimeHandle.runtimeHostId,
      payload: {
        type: "cancel",
        commandId: generateId(),
        runId: handle.runtimeHandle.runId,
        conversationId,
      },
    });
    if (options?.endResponse) {
      await handle.saveRun(false, options.reason);
      handle.stream.end();
      handle.stream.detach();
    }
    return { runId: handle.runId, hadHandle: true };
  }
}

/**
 * 从 AG-UI `RunAgentInput.resume[]` 提取 provider-agnostic payload（【决策2】）。
 *
 * 接受 `status: "resolved"` 和 `status: "cancelled"` 两种状态:
 * - `resolved` → 透传不透明 `payload`（Claude 问答的 `{answers}`、Codex 审批的
 *   `{decision}` 或 `{permissions,scope}` 等）。
 * - `cancelled` → payload 统一替换为 `{ status: "cancelled" }`，由 adapter 映射为
 *   decline/cancel。
 *
 * interruptId 不做匹配校验——adapter 按 threadId 单槽 resolve，错误 id 无副作用。
 */
function extractResumePayload(resume: unknown): {
  status: "resolved" | "cancelled";
  payload: unknown;
} {
  if (!Array.isArray(resume) || resume.length === 0) {
    throw new BadRequestException("resume must be a non-empty array");
  }
  const entry = resume[0] as Record<string, unknown> | null;
  if (
    !entry ||
    typeof entry !== "object" ||
    typeof entry.interruptId !== "string"
  ) {
    throw new BadRequestException(
      'resume entry must be { interruptId, status: "resolved"|"cancelled", payload? }'
    );
  }
  const status = entry.status;
  if (status !== "resolved" && status !== "cancelled") {
    throw new BadRequestException(
      'resume entry status must be "resolved" or "cancelled"'
    );
  }
  // cancelled → normalize payload to { status: "cancelled" }
  if (status === "cancelled") {
    return { status: "cancelled", payload: { status: "cancelled" } };
  }
  // resolved → pass through opaque payload
  return { status: "resolved", payload: entry.payload };
}

type AdminRunListRow = Awaited<
  ReturnType<RunRepository["listForAdmin"]>
>["runs"][number];

type AdminRunDetailRow = NonNullable<
  Awaited<ReturnType<RunRepository["findAdminDetail"]>>
>;

/** 管理端列表项响应形状:摊平 owner 上下文,附派生字段。 */
function toAdminRunListItem(row: AdminRunListRow) {
  const { conversation, ...run } = row;
  return {
    ...run,
    userId: conversation.workspace.userId,
    workspaceId: conversation.workspaceId,
    username: conversation.workspace.user.username,
    conversationTitle: conversation.title,
    workspaceName: conversation.workspace.name,
  };
}

/** 管理端详情响应形状:摊平派生字段 + 保留 conversation / workspace / user 嵌套视图。 */
function toAdminRunDetail(row: AdminRunDetailRow) {
  const { conversation, ...runData } = row;
  const workspace = conversation.workspace;
  return {
    ...runData,
    userId: workspace.userId,
    workspaceId: conversation.workspaceId,
    username: workspace.user.username,
    conversationTitle: conversation.title,
    workspaceName: workspace.name,
    conversation: {
      id: conversation.id,
      title: conversation.title,
      runStatus: conversation.runStatus,
      pendingUserAction: conversation.pendingUserAction,
      agentSessionId: conversation.agentSessionId,
    },
    workspace: {
      id: workspace.id,
      name: workspace.name,
    },
    user: {
      id: workspace.user.id,
      username: workspace.user.username,
    },
  };
}
