import { Injectable, Logger } from "@nestjs/common";
import type { RunStatusPayload } from "@agework/shared/protocol";
import { ConversationService } from "../../conversations/conversation.service";
import { swallow } from "../../common/swallow";
import type { RunHandle } from "./run-active.store";
import { RunActiveStore } from "./run-active.store";
import type {
  RunStatusEffect,
  RunStatusPersistenceAction,
} from "./run-lifecycle.policy";
import { RunRepository } from "../run.repository";

@Injectable()
export class RunStatusHandler {
  private readonly logger = new Logger(RunStatusHandler.name);

  constructor(
    private readonly runService: RunRepository,
    private readonly conversationService: ConversationService,
    private readonly runRegistry: RunActiveStore
  ) {}

  async apply(input: {
    runId: string;
    payload: RunStatusPayload;
    effect: RunStatusEffect;
    handle: RunHandle | undefined;
  }): Promise<void> {
    const { runId, payload, effect, handle } = input;

    await this.applyRunPersistence(runId, payload, effect.persistenceAction);
    if (effect.savePartialMessage) {
      // requires_action needs the current assistant/tool part persisted even
      // though the run is not terminal yet.
      handle?.saveRun(false);
    }

    if (handle && payload.pendingAction !== undefined) {
      await this.conversationService
        .setPendingUserAction(handle.conversationId, payload.pendingAction)
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
        await this.runService
          .markRunning(runId)
          .catch(swallow(this.logger, `mark run ${runId} running`));
        break;
      case "markRequiresAction":
        await this.runService
          .markRequiresAction(runId)
          .catch(swallow(this.logger, `mark run ${runId} requires_action`));
        break;
      case "markFinished":
        await this.runService
          .markFinished(runId)
          .catch(swallow(this.logger, `mark run ${runId} finished`));
        break;
      case "markError":
        await this.runService
          .markError(runId, payload.error ?? "unknown error")
          .catch(swallow(this.logger, `mark run ${runId} error`));
        break;
      case "markCancelled":
        await this.runService
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
    handle: RunHandle
  ): Promise<void> {
    await this.updateConversationTerminalStatus(runId, effect, handle);
    try {
      handle.saveRun(
        effect.terminalMessageComplete === true,
        handle.stopReason ?? effect.terminalIncompleteReason
      );
      this.writeTerminalSse(runId, payload, effect, handle);
    } finally {
      this.runRegistry.unregister(runId);
    }
  }

  private async updateConversationTerminalStatus(
    runId: string,
    effect: RunStatusEffect,
    handle: RunHandle
  ): Promise<void> {
    if (!effect.terminalConversationStatus) return;

    // 查询失败时返回 undefined（区别于查询成功但无活跃 run 的 null），跳过状态重置，
    // 但不能让异常中断下面的 saveRun / SSE 收尾 / unregister。
    const newerActiveRun = await this.runService
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
      .setActiveRunStatus(
        handle.conversationId,
        effect.terminalConversationStatus
      )
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
    handle: RunHandle
  ): void {
    if (!handle.res || handle.res.writableEnded) return;

    if (handle.streamingSnapshot) {
      const finalSnap = handle.aggregator.build(
        effect.terminalMessageComplete === true,
        effect.terminalIncompleteReason
      );
      handle.res.write(
        `data: ${JSON.stringify({
          content: finalSnap.content,
          status: finalSnap.status,
          ...(finalSnap.metadata ? { metadata: finalSnap.metadata } : {}),
        })}\n\n`
      );
    } else if (payload.status === "error") {
      const errorEvent = {
        type: "RUN_ERROR",
        threadId: handle.conversationId,
        runId,
        message: payload.error ?? "unknown error",
      };
      handle.res.write(`data: ${JSON.stringify(errorEvent)}\n\n`);
    }

    handle.res.end();
  }
}
