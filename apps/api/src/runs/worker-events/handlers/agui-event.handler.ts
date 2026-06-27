import { Injectable, Logger } from "@nestjs/common";
import type { RunUsage } from "@agework/shared/protocol";
import { errorLogFields, safeLogJson } from "../../../common/logging";
import { swallow } from "../../../common/swallow";
import { RunRepository } from "../../run.repository";
import { RunConversationEffects } from "../../conversation/run-conversation.effects";
import {
  LiveRunRegistry,
  type LiveRunHandle,
} from "../../live-runs/live-run.registry";
import { WorkerRunEventRecorder } from "../run-event.recorder";

const CHUNK_SAVE_INTERVAL = 20;

@Injectable()
export class WorkerAgUiEventHandler {
  private readonly logger = new Logger(WorkerAgUiEventHandler.name);
  private readonly chunkCounters = new Map<string, number>();

  constructor(
    private readonly runRepository: RunRepository,
    private readonly liveRuns: LiveRunRegistry,
    private readonly runConversation: RunConversationEffects,
    private readonly eventRecorder: WorkerRunEventRecorder
  ) {}

  async handle(runId: string, event: unknown): Promise<void> {
    const handle = this.liveRuns.get(runId);
    if (!handle) {
      this.logger.warn(
        `drop AG-UI event without live handle ${safeLogJson({ runId })}`
      );
      return;
    }

    const evt = event as Record<string, unknown>;
    const eventType = typeof evt.type === "string" ? evt.type : "unknown";
    if (this.eventRecorder.shouldLogAgUiEvent(eventType)) {
      this.logger.debug(
        `forward AG-UI event ${safeLogJson({ runId, type: eventType })}`
      );
    }
    this.eventRecorder.recordAgUi(runId, eventType, evt);
    handle.aggregator.handle(evt as { type: string; [key: string]: unknown });

    this.saveAndSnapshotOnMessageBoundary(runId, evt, handle);

    if (this.handleCustomEvent(evt, handle)) return;

    // MESSAGES_SNAPSHOT is only used for server-side aggregation/persistence;
    // forwarding it would duplicate messages already built incrementally on the client.
    if (evt.type === "MESSAGES_SNAPSHOT") return;
    // RUN_CANCELLED is not part of the AG-UI client event schema used by the web runtime.
    // Keep it for server-side aggregation/diagnostics only; run.status=cancelled performs terminal cleanup.
    if (evt.type === "RUN_CANCELLED") return;

    // Resume streams use accumulated snapshots instead of raw AG-UI events.
    if (!handle.stream.isSnapshotMode) {
      handle.stream.writeEvent(event);
    }

    this.persistUsageFromRunFinished(runId, evt);
  }

  clearRun(runId: string): void {
    this.chunkCounters.delete(runId);
  }

  private saveAndSnapshotOnMessageBoundary(
    runId: string,
    evt: Record<string, unknown>,
    handle: LiveRunHandle
  ): void {
    if (
      evt.type === "TEXT_MESSAGE_CONTENT" ||
      evt.type === "TEXT_MESSAGE_CHUNK"
    ) {
      const count = (this.chunkCounters.get(runId) ?? 0) + 1;
      this.chunkCounters.set(runId, count);
      if (count % CHUNK_SAVE_INTERVAL === 0) {
        handle.saveRun(false);
        this.writeSnapshotToHandle(handle);
      }
    }

    if (
      evt.type === "TEXT_MESSAGE_END" ||
      evt.type === "TOOL_CALL_RESULT" ||
      evt.type === "THINKING_END" ||
      evt.type === "THINKING_TEXT_MESSAGE_END" ||
      evt.type === "REASONING_END" ||
      evt.type === "REASONING_MESSAGE_END"
    ) {
      this.chunkCounters.set(runId, 0);
      handle.saveRun(false);
      this.writeSnapshotToHandle(handle);
    }
  }

  private handleCustomEvent(
    evt: Record<string, unknown>,
    handle: LiveRunHandle
  ): boolean {
    if (evt.type !== "CUSTOM" || !handle.conversationId) return false;

    if (evt.name === "agent.sessionId" && typeof evt.value === "string") {
      handle.onAgentSessionId?.(evt.value);
      this.persistAgentSessionId(handle.conversationId, evt.value);
      return true;
    }

    if (evt.name === "system:init") {
      const value = evt.value as { session_id?: unknown } | undefined;
      if (typeof value?.session_id === "string") {
        handle.onAgentSessionId?.(value.session_id);
        this.persistAgentSessionId(handle.conversationId, value.session_id);
      }
    }

    return false;
  }

  private persistAgentSessionId(
    conversationId: string,
    sessionId: string
  ): void {
    this.runConversation
      .saveAgentSessionId(conversationId, sessionId)
      .catch((err) =>
        this.logger.warn(
          `persist agent session id failed ${safeLogJson({
            conversationId,
            ...errorLogFields(err),
          })}`
        )
      );
  }

  private writeSnapshotToHandle(handle: LiveRunHandle): void {
    if (!handle.stream.isSnapshotMode) {
      return;
    }
    const snap = handle.aggregator.build(false, "streaming");
    if (snap.content.length === 0) return;
    handle.stream.writeSnapshot({
      content: snap.content,
      status: snap.status,
      ...(snap.metadata ? { metadata: snap.metadata } : {}),
    });
  }

  private persistUsageFromRunFinished(
    runId: string,
    evt: Record<string, unknown>
  ): void {
    if (evt.type !== "RUN_FINISHED") return;

    const usage = normalizeRunUsage(evt.result);
    if (!usage) return;

    this.runRepository
      .recordUsage(runId, usage)
      .catch(swallow(this.logger, `record usage for run ${runId}`));
  }
}

/**
 * 从 `RUN_FINISHED.result`（unknown）安全抽取并归一化为 `RunUsage`。
 *
 * 两个 adapter 上报的字段名不同：
 * - Codex：`{ usage: { input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens }, numTurns }`
 * - Claude：`{ usage: { input_tokens, cache_read_input_tokens, cache_creation_input_tokens, output_tokens }, totalCostUsd, numTurns }`
 *
 * 任一非数值字段按 0 处理；整体为 null/非对象/没有任何已知 token 字段时返回 null。
 */
function normalizeRunUsage(result: unknown): RunUsage | null {
  if (!result || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;
  const usageRaw = r.usage;
  const usage =
    usageRaw && typeof usageRaw === "object"
      ? (usageRaw as Record<string, unknown>)
      : {};

  const inputTokens = num(usage.input_tokens);
  const outputTokens = num(usage.output_tokens);
  const cachedInputTokens =
    num(usage.cached_input_tokens) || num(usage.cache_read_input_tokens);
  const reasoningOutputTokens = num(usage.reasoning_output_tokens);
  const cacheCreationInputTokens = num(usage.cache_creation_input_tokens);
  const totalCostUsd = nullableNum(r.totalCostUsd);
  const numTurns = num(r.numTurns);
  const durationApiMs = nullableNum(r.durationApiMs);

  if (
    inputTokens === 0 &&
    outputTokens === 0 &&
    cachedInputTokens === 0 &&
    reasoningOutputTokens === 0 &&
    cacheCreationInputTokens === 0 &&
    totalCostUsd === null &&
    numTurns === 0 &&
    durationApiMs === null
  ) {
    return null;
  }

  return {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    reasoningOutputTokens,
    cacheCreationInputTokens,
    totalCostUsd,
    numTurns,
    durationApiMs,
  };
}

/** 取数值字段：非有限数（含 null/undefined/NaN/string）一律视为 0。 */
function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** 取可空数值：非有限数返回 null（用于 cost 这类「有就有、没有就空」的字段）。 */
function nullableNum(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
