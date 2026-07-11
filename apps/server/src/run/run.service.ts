import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from "@nestjs/common";
import { generateId } from "@agework/shared";
import type { Response } from "express";
import { swallow } from "../common/swallow";
import { RunRepository } from "./run.repository";
import { LiveRunRegistry } from "./live-run/live-run.registry";
import { RunDriver } from "./driver/run-driver";
import { WorkerManagerService } from "../worker-manager/worker-manager.service";
import { type IncompleteMessageReason } from "./upstream/assistant-message.aggregator";
import { RunEventService } from "../run-event/run-event.service";
import { RunStatusService } from "./status/run-status.service";
import type { StartRunInput } from "./run.types";
import { RunStream } from "./streaming/run-stream";
import { RunLauncher } from "./launch/run-launcher";
import { RunRecoveryService } from "./recovery/run-recovery.service";

@Injectable()
export class RunService implements OnApplicationBootstrap {
  private readonly logger = new Logger(RunService.name);
  private recoveryStarted = false;

  constructor(
    private readonly runRepository: RunRepository,
    private readonly liveRuns: LiveRunRegistry,
    private readonly driver: RunDriver,
    private readonly runEvents: RunEventService,
    private readonly runStatusService: RunStatusService,
    private readonly runLauncher: RunLauncher,
    private readonly workerManager: WorkerManagerService,
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

  /** 管理端：分页查询 run 列表。 */
  listForAdmin(params: { status?: string; take: number; skip: number }) {
    return this.runRepository.listAdmin(params);
  }

  /** 管理端：单个 run 详情；runtime 实例视图经 WorkerManagerService 补齐。 */
  async getDetailForAdmin(id: string) {
    const detail = await this.runRepository.detailAdmin(id);
    const workerInstance = detail.runtimeInstanceId
      ? await this.workerManager.getWorkerInstanceForAdmin(
          detail.runtimeType,
          detail.runtimeInstanceId
        )
      : null;
    return { ...detail, workerInstance };
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
   * 启动一次 run。出站启动准备（placement / RunConfig / 落库 / 拉起 worker / 注册 handle）
   * 全部委托给 RunLauncher；RunService 只注入「让位旧 run」端口，供 user_steered 时停掉活跃 run。
   */
  async start(input: StartRunInput): Promise<void> {
    await this.runLauncher.launch(input, {
      stopActiveRun: (conversationId, options) =>
        this.stop(conversationId, options),
    });
  }

  /**
   * Interrupt 答复续接（terminal model）：校验 resume[] 后先把新 SSE 附接到
   * 活跃 run 的 handle（事件模式，保证续接段的 RUN_STARTED 不漏），再把答案
   * 经 approval_resolved 命令下发给 worker；adapter 解开挂起后以 resumeRunId
   * 发 RUN_STARTED，后续事件流入本次 res。
   * 无活跃 run 或不在待答状态时抛 Conflict，前端 invalidate 后按最新状态走。
   */
  async resumeWithAnswers(input: {
    conversationId: string;
    resumeRunId: string;
    resume: unknown;
    res: Response;
  }): Promise<void> {
    const { conversationId, resumeRunId, res } = input;
    const answers = extractResumeAnswers(input.resume);

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

    this.driver.sendCommand(handle.runtimeHandle, {
      type: "approval_resolved",
      commandId: generateId(),
      conversationId,
      answers,
      resumeRunId,
    });
    const runId = handle.runtimeHandle.runId;
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
   * @returns 是否存在活跃的 in-memory run handle。
   *   conversation agent 路由用此判断是否需要重置 conversation status。
   */
  async stop(
    conversationId: string,
    options?: { reason?: IncompleteMessageReason; endResponse?: boolean }
  ): Promise<boolean> {
    const activeRunRecord =
      await this.runRepository.findActiveByConversationId(conversationId);
    const handle = activeRunRecord
      ? this.liveRuns.get(activeRunRecord.id)
      : undefined;
    if (!handle) {
      // No in-memory handle — clean up stale state
      if (activeRunRecord) {
        await this.runStatusService.markCancelledWithoutHandle(
          activeRunRecord.id
        );
      }
      return false;
    }
    handle.stopRequested = true;
    handle.stopReason = options?.reason;
    if (activeRunRecord) {
      await this.runStatusService.markCancelRequested(
        activeRunRecord.id,
        options?.reason
      );
    }
    this.driver.cancel(handle.runtimeHandle);
    if (options?.endResponse) {
      handle.saveRun(false, options.reason);
      handle.stream.end();
      handle.stream.detach();
    }
    return true;
  }
}

/**
 * 从 AG-UI `RunAgentInput.resume[]` 提取答案。问答当前是单槽(一次只有一个
 * open interrupt),取第一个 resolved entry 的 `payload.answers`。
 * interruptId 不做匹配校验——adapter 按 threadId 单槽 resolve,错误 id 无副作用。
 */
function extractResumeAnswers(
  resume: unknown
): Record<string, string | string[]> {
  if (!Array.isArray(resume) || resume.length === 0) {
    throw new BadRequestException("resume must be a non-empty array");
  }
  const entry = resume[0] as Record<string, unknown> | null;
  if (
    !entry ||
    typeof entry !== "object" ||
    typeof entry.interruptId !== "string" ||
    entry.status !== "resolved"
  ) {
    throw new BadRequestException(
      'resume entry must be { interruptId, status: "resolved", payload }'
    );
  }
  const payload = entry.payload as Record<string, unknown> | undefined;
  const answers = payload?.answers;
  if (!isAnswerRecord(answers)) {
    throw new BadRequestException(
      "resume payload.answers must be a record of string | string[]"
    );
  }
  return answers;
}

function isAnswerRecord(
  value: unknown
): value is Record<string, string | string[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every(
    (item) =>
      typeof item === "string" ||
      (Array.isArray(item) && item.every((inner) => typeof inner === "string"))
  );
}
