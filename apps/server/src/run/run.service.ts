import {
  Injectable,
  Logger,
  NotFoundException,
  type OnApplicationBootstrap,
} from "@nestjs/common";
import { generateId } from "@agework/shared";
import type { Response } from "express";
import { RunRepository } from "./run.repository";
import { LiveRunRegistry } from "./live-run/live-run.registry";
import { WorkerRunExecutor } from "./execution/worker-run.executor";
import { WorkerHostService } from "../worker-host/worker-host.service";
import { type IncompleteMessageReason } from "./worker-event/assistant-message.aggregator";
import { swallow } from "../common/swallow";
import { RunEventService } from "../run-event/run-event.service";
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
    private readonly executor: WorkerRunExecutor,
    private readonly runEvents: RunEventService,
    private readonly runLauncher: RunLauncher,
    private readonly workerHost: WorkerHostService,
    private readonly runRecovery: RunRecoveryService
  ) {}

  /**
   * 应用启动后触发一次性重启恢复。run 现在直接依赖 ConversationService
   *（经 RunConversationEffects 向下写入），不再需要运行期绑定反向端口。
   */
  async onApplicationBootstrap(): Promise<void> {
    if (this.recoveryStarted) return;
    this.recoveryStarted = true;
    await this.runRecovery.recoverInterruptedRuns();
  }

  /** 管理端：分页查询 run 列表。 */
  listForAdmin(params: { status?: string; take: number; skip: number }) {
    return this.runRepository.listAdmin(params);
  }

  /** 管理端：单个 run 详情；runtime 实例视图经 WorkerHostService 补齐。 */
  async getDetailForAdmin(id: string) {
    const detail = await this.runRepository.detailAdmin(id);
    const runtimeInstance = detail.runtimeInstanceId
      ? await this.workerHost.getRuntimeInstanceForAdmin(
          detail.runtimeType,
          detail.runtimeInstanceId
        )
      : null;
    return { ...detail, runtimeInstance };
  }

  /** 管理端：按 run 查询事件（编排 run-events 的读路径）。 */
  listEventsForAdmin(params: Parameters<RunEventService["listForAdmin"]>[0]) {
    return this.runEvents.listForAdmin(params);
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

  /** 把审批结果通过活跃 run 的 worker 通道下发；无活跃 run 时抛 NotFound。 */
  async reply(
    conversationId: string,
    answers: Record<string, string | string[]>
  ): Promise<void> {
    const activeRun =
      await this.runRepository.findActiveByConversationId(conversationId);
    const handle = activeRun ? this.liveRuns.get(activeRun.id) : undefined;
    if (!handle) {
      throw new NotFoundException(
        `No active run for conversation: ${conversationId}`
      );
    }
    this.executor.sendCommand(handle.runtimeHandle, {
      type: "approval_resolved",
      commandId: generateId(),
      conversationId,
      answers: answers ?? {},
    });
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

    // 等待审批的 run 首版不续接 stream（前端走正常 load 显示历史 + 审批 UI）
    if (activeRunRecord?.status === "requires_action") {
      const stream = new RunStream(res);
      stream.setStatus(409);
      stream.end();
      return;
    }

    // 接管 SSE 连接：原连接（刷新前）已断，单订阅直接替换
    // 守卫：若旧连接尚未关闭（close 事件未触发的 race condition），主动 end 防连接泄漏
    handle.stream.replace(res, "snapshots");

    // 补发当前累积快照（resume 流的起点，含已输出的全部内容）
    const initial = handle.aggregator.build(false, "streaming");
    handle.stream.writeSnapshot(this.toRunResult(initial));

    handle.stream.onClose(() => {
      // 连接断开只清引用，不取消 run（与正常 run 的 res.on close 一致）
      const current = this.liveRuns.get(handle.runId);
      if (current?.stream.isAttachedTo(res)) {
        current.stream.detach(res);
      }
    });
  }

  private toRunResult(snap: {
    content: unknown[];
    status: unknown;
    metadata?: Record<string, unknown>;
  }): { content: unknown[]; status: unknown; metadata?: unknown } {
    return {
      content: snap.content,
      status: snap.status,
      ...(snap.metadata ? { metadata: snap.metadata } : {}),
    };
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
        await this.runRepository.markCancelled(activeRunRecord.id);
        this.runEvents
          .append(
            this.runEvents.runStatusChanged({
              runId: activeRunRecord.id,
              origin: "platform",
              status: "cancelled",
              reason: "cancelled_without_handle",
            })
          )
          .catch(
            swallow(
              this.logger,
              `record cancel without handle for run ${activeRunRecord.id}`
            )
          );
      }
      return false;
    }
    handle.stopRequested = true;
    handle.stopReason = options?.reason;
    if (activeRunRecord) {
      await this.runRepository.markCancelling(activeRunRecord.id);
      this.runEvents
        .append(
          this.runEvents.runStatusChanged({
            runId: activeRunRecord.id,
            origin: "platform",
            status: "cancelling",
            reason: options?.reason,
          })
        )
        .catch(
          swallow(
            this.logger,
            `record cancel request for run ${activeRunRecord.id}`
          )
        );
    }
    this.executor.cancel(handle.runtimeHandle);
    if (options?.endResponse) {
      handle.saveRun(false, options.reason);
      handle.stream.end();
      handle.stream.detach();
    }
    return true;
  }
}
