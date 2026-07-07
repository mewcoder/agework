import { Injectable, Logger } from "@nestjs/common";
import type { RunStatusPayload } from "@agework/shared/protocol";
import { safeLogJson } from "../../common/logging";
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
import { WorkerSeqStore } from "../upstream/worker-seq.store";
import { WorkerAgUiEventHandler } from "../upstream/worker-agui-event.handler";
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
    private readonly seqGate: WorkerSeqStore,
    private readonly aguiEvents: WorkerAgUiEventHandler,
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
  }): Promise<void> {
    const { runId, payload, effect } = input;
    const isTerminal = effect.isTerminal;
    this.logger[isTerminal ? "log" : "debug"](
      `run status ${safeLogJson({
        runId,
        status: payload.status,
        pendingAction: payload.pendingAction,
        error: payload.error,
      })}`
    );
    if (isTerminal) {
      this.finalization.beginFinalizing(runId);
    }
    this.recordStatusEvent(runId, payload);
    if (effect.persistenceAction === "markRequiresAction") {
      this.runEvents
        .append(this.runEvents.permissionRequested({ runId }))
        .catch(
          swallow(this.logger, `record permission requested for run ${runId}`)
        );
    }

    try {
      const handle = this.liveRuns.get(runId);

      // 终态完成后记录 completed，阻止延迟的 exit handler 覆盖。
      // 必须在 saveRun/stream write 等可能抛异常的操作之前设置，
      // 否则异常会跳过记录，导致终态 guard 失效。
      if (isTerminal) {
        this.finalization.markCompleted(runId);
      }

      await this.applyRunPersistence(runId, payload, effect.persistenceAction);
      if (effect.savePartialMessage) {
        // requires_action needs the current assistant/tool part persisted even
        // though the run is not terminal yet.
        handle?.saveRun(false);
      }

      if (handle && payload.pendingAction !== undefined) {
        await this.conversationService
          .setConversationRunState(handle.conversationId, {
            pendingUserAction: payload.pendingAction,
          })
          .catch(
            swallow(
              this.logger,
              `set pending user action for conversation ${handle.conversationId}`
            )
          );
      }

      if (isTerminal && handle) {
        await this.applyTerminalEffects(runId, payload, effect, handle);
      }
    } finally {
      // 终态收敛的统一清理点:解除守卫 + 一次性遗忘全部 per-run 内存态。
      if (isTerminal) {
        this.finalization.endFinalizing(runId);
        this.seqGate.forget(runId);
        this.aguiEvents.clearRun(runId);
        this.runEvents.forgetRun(runId);
      }
    }
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

  /** 平台侧取消:DB 有活跃行但无内存 handle(重启遗留等),直接落 cancelled 终态并记账。 */
  async markCancelledWithoutHandle(runId: string): Promise<void> {
    await this.runRepository.markCancelled(runId);
    this.recordPlatformStatusChanged(
      runId,
      "cancelled",
      "cancelled_without_handle",
      `record cancel without handle for run ${runId}`
    );
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
        await this.runRepository
          .markRunning(runId)
          .catch(swallow(this.logger, `mark run ${runId} running`));
        break;
      case "markRequiresAction":
        await this.runRepository
          .markRequiresAction(runId)
          .catch(swallow(this.logger, `mark run ${runId} requires_action`));
        break;
      case "markFinished":
        await this.runRepository
          .markFinished(runId)
          .catch(swallow(this.logger, `mark run ${runId} finished`));
        break;
      case "markError":
        await this.runRepository
          .markError(runId, payload.error ?? "unknown error")
          .catch(swallow(this.logger, `mark run ${runId} error`));
        break;
      case "markCancelled":
        await this.runRepository
          .markCancelled(runId)
          .catch(swallow(this.logger, `mark run ${runId} cancelled`));
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
    await this.updateConversationTerminalStatus(runId, effect, handle);
    try {
      if (effect.terminalMessageComplete !== true) {
        this.recordMessageFailed(runId, effect, handle);
      }
      handle.saveRun(
        effect.terminalMessageComplete === true,
        handle.stopReason ?? effect.terminalIncompleteReason
      );
      this.writeTerminalSse(runId, payload, effect, handle);
    } finally {
      this.liveRuns.unregister(runId);
    }
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
    handle: LiveRunHandle
  ): Promise<void> {
    if (!effect.terminalConversationStatus) return;

    // 查询失败时返回 undefined（区别于查询成功但无活跃 run 的 null），跳过状态重置，
    // 但不能让异常中断下面的 saveRun / SSE 收尾 / unregister。
    const newerActiveRun = await this.runRepository
      .findActiveByConversationId(handle.conversationId)
      .catch((err: unknown) => {
        swallow(
          this.logger,
          `find active run for conversation ${handle.conversationId}`
        )(err);
        return undefined;
      });
    if (
      newerActiveRun === undefined ||
      (newerActiveRun && newerActiveRun.id !== runId)
    ) {
      return;
    }

    await this.conversationService
      .setConversationRunState(handle.conversationId, {
        runStatus: effect.terminalConversationStatus,
      })
      .catch(
        swallow(
          this.logger,
          `set active run status for conversation ${handle.conversationId}`
        )
      );
  }

  private writeTerminalSse(
    runId: string,
    payload: RunStatusPayload,
    effect: RunStatusEffect,
    handle: LiveRunHandle
  ): void {
    if (handle.stream.isSnapshotMode) {
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
