import { Injectable, Inject, Logger } from "@nestjs/common";
import type { RunStatusPayload } from "@agework/shared/protocol";
import { swallow } from "../../common/swallow";
import type { LiveRunHandle } from "../live-run/live-run.registry";
import { LiveRunRegistry } from "../live-run/live-run.registry";
import {
  CONVERSATION_EFFECTS_PORT,
  type ConversationEffectsPort,
} from "../run.types";
import type {
  RunStatusEffect,
  RunStatusPersistenceAction,
} from "./run-status.policy";
import { RunRepository } from "../run.repository";

@Injectable()
export class RunStatusService {
  private readonly logger = new Logger(RunStatusService.name);

  constructor(
    private readonly runRepository: RunRepository,
    @Inject(CONVERSATION_EFFECTS_PORT)
    private readonly conversationEffects: ConversationEffectsPort,
    private readonly liveRuns: LiveRunRegistry
  ) {}

  async apply(input: {
    runId: string;
    payload: RunStatusPayload;
    effect: RunStatusEffect;
    handle: LiveRunHandle | undefined;
  }): Promise<void> {
    const { runId, payload, effect, handle } = input;

    await this.applyRunPersistence(runId, payload, effect.persistenceAction);
    if (effect.savePartialMessage) {
      // requires_action needs the current assistant/tool part persisted even
      // though the run is not terminal yet.
      handle?.saveRun(false);
    }

    if (handle && payload.pendingAction !== undefined) {
      await this.conversationEffects
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

    if (effect.isTerminal && handle) {
      await this.applyTerminalEffects(runId, payload, effect, handle);
    }
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
      handle.saveRun(
        effect.terminalMessageComplete === true,
        handle.stopReason ?? effect.terminalIncompleteReason
      );
      this.writeTerminalSse(runId, payload, effect, handle);
    } finally {
      this.liveRuns.unregister(runId);
    }
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

    await this.conversationEffects
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
      const finalSnap = handle.aggregator.build(
        effect.terminalMessageComplete === true,
        incompleteReason
      );
      handle.stream.writeSnapshot({
        content: finalSnap.content,
        status: finalSnap.status,
        ...(finalSnap.metadata ? { metadata: finalSnap.metadata } : {}),
      });
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
