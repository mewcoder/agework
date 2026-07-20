import { Injectable, Logger } from "@nestjs/common";
import type { RunStatusPayload } from "@agework/shared/protocol";
import { swallow } from "../../common/swallow";
import type { LiveRunHandle } from "../live-run/live-run.registry";
import { LiveRunRegistry } from "../live-run/live-run.registry";
import { ConversationService } from "../../conversation/conversation.service";
import {
  decideRunStatusUpdate,
  type RunStatusDecision,
  type RunStatusEffect,
  type RunStatusPersistenceAction,
} from "./run-status.policy";
import { RunRepository } from "../run.repository";
import { RunFinalizationStore } from "./run-finalization.store";
import { UpstreamSeqStore } from "../upstream/upstream-seq.store";
import { HostAgUiEventHandler } from "../upstream/host-agui-event.handler";
import { RunEventService } from "../../run-event/run-event.service";

/**
 * run 状态迁移的唯一 owner:决策(policy + 终态守卫)、状态事件落账、run 落库、
 * 会话状态回写、流收尾、终态后清理全部 per-run 内存态,整条序列都在 apply 里
 * 一处走完。终态守卫 begin/markCompleted/end 的时序由本类持有,调用方不感知。
 * 平台侧主动取消(stop 路径)的状态写入也收在这里,不允许旁路直写 repository。
 */
@Injectable()
export class RunStatusService {
  private readonly logger = new Logger(RunStatusService.name);

  constructor(
    private readonly runRepository: RunRepository,
    private readonly conversationService: ConversationService,
    private readonly liveRuns: LiveRunRegistry,
    private readonly finalization: RunFinalizationStore,
    private readonly seqGate: UpstreamSeqStore,
    private readonly aguiEvents: HostAgUiEventHandler,
    private readonly runEvents: RunEventService
  ) {}

  /** run.status 的 apply/ignore 决策:已终态 / 终态处理中的 run 忽略后续状态。 */
  decide(runId: string, payload: RunStatusPayload): RunStatusDecision {
    return decideRunStatusUpdate({
      nextStatus: payload.status,
      terminalOrFinalizing: this.isTerminalOrFinalizing(runId),
    });
  }

  /** run 是否已在终态处理中或已完成终态(供上行入口 / exit handler 判断跳过)。 */
  isTerminalOrFinalizing(runId: string): boolean {
    return this.finalization.isTerminalOrFinalizing(runId);
  }

  /** 应用一次已通过 decide 的状态迁移,终态时走完整条收敛序列。 */
  async apply(input: {
    runId: string;
    payload: RunStatusPayload;
    effect: RunStatusEffect;
    /** 无 LiveRunHandle 的平台恢复路径用它回写会话终态。 */
    conversationId?: string;
    /** worker 上行默认 runtime；恢复/平台主动终结显式标 platform。 */
    origin?: "runtime" | "platform";
  }): Promise<void> {
    const {
      runId,
      payload,
      effect,
      conversationId,
      origin = "runtime",
    } = input;
    const terminal = effect.terminal;
    this.logger[terminal ? "log" : "debug"]("run status", {
      runId,
      status: payload.status,
      pendingAction: payload.pendingAction,
      error: payload.error,
    });
    if (terminal) {
      this.finalization.beginFinalizing(runId);
    }
    if (origin === "platform") {
      this.recordPlatformStatusChanged(
        runId,
        payload.status,
        payload.error,
        `record platform run status for run ${runId}`
      );
    } else {
      this.recordStatusEvent(runId, payload);
    }
    if (effect.persistenceAction === "markRequiresAction") {
      this.runEvents
        .append(this.runEvents.permissionRequested({ runId }))
        .catch(
          swallow(this.logger, `record permission requested for run ${runId}`)
        );
    }

    try {
      const handle = this.liveRuns.get(runId);

      await this.applyRunPersistence(runId, payload, effect.persistenceAction);
      if (effect.savePartialMessage) {
        // requires_action needs the current assistant/tool part persisted even
        // though the run is not terminal yet.
        await handle?.saveRun(false);
      }

      if (handle && payload.pendingAction !== undefined) {
        await this.conversationService.setConversationRunState(
          handle.conversationId,
          { pendingUserAction: payload.pendingAction }
        );
      }

      if (terminal) {
        const terminalConversationId = handle?.conversationId ?? conversationId;
        if (terminalConversationId) {
          await this.updateConversationTerminalStatus(
            runId,
            effect,
            terminalConversationId
          );
        }
        if (handle) {
          await this.applyTerminalEffects(runId, payload, effect, handle);
        }
      }

      // 只有全部终态副作用成功后才记 completed。失败时保留 live handle 与
      // per-run 状态，让未 ACK 的同一事件重放后可以继续完成收尾。
      if (terminal) {
        this.finalization.markCompleted(runId);
      }
    } finally {
      // 终态失败只解除 finalizing，成功才遗忘全部 per-run 内存态。
      if (terminal) {
        this.finalization.endFinalizing(runId);
        if (this.finalization.isCompleted(runId)) {
          this.seqGate.forget(runId);
          this.aguiEvents.clearRun(runId);
          this.runEvents.forgetRun(runId);
        }
      }
    }
  }

  /**
   * 平台/恢复侧把 run 收敛为 error。无论 LiveRunHandle 是否存在都复用 apply:
   * 有 handle 时完整保存消息、结束 SSE 并清理内存；无 handle 时仍统一完成
   * Run/Conversation 持久化、状态事件和终态守卫。
   */
  async failRun(input: {
    runId: string;
    conversationId: string;
    error: string;
  }): Promise<void> {
    const payload: RunStatusPayload = {
      status: "error",
      error: input.error,
    };
    const decision = this.decide(input.runId, payload);
    if (decision.action === "ignore") return;
    await this.apply({
      runId: input.runId,
      payload,
      effect: decision.effect,
      conversationId: input.conversationId,
      origin: "platform",
    });
  }

  /** 平台侧取消请求:活跃 run 标记 cancelling 并记账;终态等 worker 上报 cancelled 收敛。 */
  async markCancelRequested(runId: string, reason?: string): Promise<void> {
    await this.runRepository.markCancelling(runId);
    this.recordPlatformStatusChanged(
      runId,
      "cancelling",
      reason,
      `record cancel request for run ${runId}`
    );
  }

  /** 平台侧取消:DB 有活跃行但无内存 handle(重启遗留等),仍复用完整终态序列。 */
  async markCancelledWithoutHandle(input: {
    runId: string;
    conversationId: string;
  }): Promise<void> {
    const payload: RunStatusPayload = {
      status: "cancelled",
      error: "cancelled_without_handle",
    };
    const decision = this.decide(input.runId, payload);
    if (decision.action === "ignore") return;
    await this.apply({
      runId: input.runId,
      payload,
      effect: decision.effect,
      conversationId: input.conversationId,
      origin: "platform",
    });
  }

  private recordStatusEvent(runId: string, payload: RunStatusPayload): void {
    this.runEvents
      .append(this.runEvents.fromRunStatusPayload(runId, payload))
      .catch(swallow(this.logger, `record run status event for run ${runId}`));
  }

  private recordPlatformStatusChanged(
    runId: string,
    status: RunStatusPayload["status"],
    reason: string | undefined,
    context: string
  ): void {
    this.runEvents
      .append(
        this.runEvents.runStatusChanged({
          runId,
          origin: "platform",
          status,
          reason,
        })
      )
      .catch(swallow(this.logger, context));
  }

  private async applyRunPersistence(
    runId: string,
    payload: RunStatusPayload,
    action: RunStatusPersistenceAction | undefined
  ): Promise<void> {
    switch (action) {
      case "markRunning":
        await this.runRepository.markRunning(runId);
        break;
      case "markRequiresAction":
        await this.runRepository.markRequiresAction(runId);
        break;
      case "markFinished":
        await this.runRepository.markFinished(runId);
        break;
      case "markError":
        await this.runRepository.markError(
          runId,
          payload.error ?? "unknown error"
        );
        break;
      case "markCancelled":
        await this.runRepository.markCancelled(runId);
        break;
      case undefined:
        break;
    }
  }

  private async applyTerminalEffects(
    runId: string,
    payload: RunStatusPayload,
    effect: RunStatusEffect,
    handle: LiveRunHandle
  ): Promise<void> {
    if (effect.terminalMessageComplete !== true) {
      this.recordMessageFailed(runId, effect, handle);
    }
    await handle.saveRun(
      effect.terminalMessageComplete === true,
      handle.stopReason ?? effect.terminalIncompleteReason
    );
    this.writeTerminalSse(runId, payload, effect, handle);
    this.liveRuns.unregister(runId);
  }

  /** run 终态但当前 assistant 消息未完成(error/cancelled)时,记录 message.failed。 */
  private recordMessageFailed(
    runId: string,
    effect: RunStatusEffect,
    handle: LiveRunHandle
  ): void {
    const { messageId } = handle.aggregator.build(
      false,
      handle.stopReason ?? effect.terminalIncompleteReason
    );
    const event = this.runEvents.messageFailed({
      runId,
      messageId,
      reason: effect.terminalIncompleteReason,
    });
    if (!event) return;
    this.runEvents
      .append(event)
      .catch(swallow(this.logger, `record message failed for run ${runId}`));
  }

  private async updateConversationTerminalStatus(
    runId: string,
    effect: RunStatusEffect,
    conversationId: string
  ): Promise<void> {
    if (!effect.terminalConversationStatus) return;

    const newerActiveRun =
      await this.runRepository.findActiveByConversationId(conversationId);
    if (newerActiveRun && newerActiveRun.id !== runId) {
      return;
    }

    await this.conversationService.setConversationRunState(conversationId, {
      runStatus: effect.terminalConversationStatus,
    });
  }

  private writeTerminalSse(
    runId: string,
    payload: RunStatusPayload,
    effect: RunStatusEffect,
    handle: LiveRunHandle
  ): void {
    if (handle.stream.snapshotMode) {
      const incompleteReason =
        handle.stopReason ?? effect.terminalIncompleteReason;
      handle.stream.writeSnapshot(
        handle.aggregator.build(
          effect.terminalMessageComplete === true,
          incompleteReason
        )
      );
    } else if (payload.status === "error") {
      handle.stream.writeError({
        threadId: handle.conversationId,
        runId,
        message: payload.error ?? "unknown error",
      });
    }

    handle.stream.end();
  }
}
