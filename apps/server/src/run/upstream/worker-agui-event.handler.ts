import { Injectable, Logger } from "@nestjs/common";
import type { RecordRunEventInput, RunUsage } from "@agework/shared/protocol";
import { safeLogJson } from "../../common/logging";
import { swallow } from "../../common/swallow";
import { RunRepository } from "../run.repository";
import {
  LiveRunRegistry,
  type LiveRunHandle,
} from "../live-run/live-run.registry";
import { RunEventService } from "../../run-event/run-event.service";

const CHUNK_SAVE_INTERVAL = 20;

@Injectable()
export class WorkerAgUiEventHandler {
  private readonly logger = new Logger(WorkerAgUiEventHandler.name);
  private readonly chunkCounters = new Map<string, number>();

  constructor(
    private readonly runRepository: RunRepository,
    private readonly liveRuns: LiveRunRegistry,
    private readonly runEvents: RunEventService
  ) {}

  handle(runId: string, event: unknown): void {
    const handle = this.liveRuns.get(runId);
    if (!handle) {
      this.logger.warn(
        `drop AG-UI event without live handle ${safeLogJson({ runId })}`
      );
      return;
    }

    const evt = event as Record<string, unknown>;
    const eventType = typeof evt.type === "string" ? evt.type : "unknown";
    if (this.runEvents.shouldLogAgUiEvent(eventType)) {
      this.logger.debug(
        `forward AG-UI event ${safeLogJson({ runId, type: eventType })}`
      );
    }
    this.recordAgUi(runId, eventType, evt);
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

  private recordAgUi(
    runId: string,
    eventType: string,
    event: Record<string, unknown>
  ): void {
    const events = this.runEvents.fromAgUiEvent(runId, eventType, event);
    for (const runEvent of events) {
      this.recordRunEvent(
        runEvent,
        `record AG-UI event ${eventType} for run ${runId}`
      );
    }
  }

  private recordRunEvent(
    event: RecordRunEventInput | undefined,
    context: string
  ): void {
    if (!event) return;
    this.runEvents.append(event).catch(swallow(this.logger, context));
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
      return true;
    }

    if (evt.name === "system:init") {
      const value = evt.value as { session_id?: unknown } | undefined;
      if (typeof value?.session_id === "string") {
        handle.onAgentSessionId?.(value.session_id);
      }
    }

    return false;
  }

  private writeSnapshotToHandle(handle: LiveRunHandle): void {
    if (!handle.stream.isSnapshotMode) {
      return;
    }
    const snap = handle.aggregator.build(false, "streaming");
    if (snap.content.length === 0) return;
    handle.stream.writeSnapshot(snap);
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
 * 从 `RUN_FINISHED.result`（unknown）安全抽取 `RunUsage`。
 *
 * adapter 侧已经把两个 SDK 各自的字段名归一化成 `RunUsage` 形状写进
 * `result.usage`（见 packages/adapters 的 `toRunUsage`），这里只做一次跨进程
 * 边界必要的运行时校验，不再猜字段名。字段名对不上时按 0/null 处理；整体为
 * null/非对象/没有任何已知字段时返回 null。
 */
function normalizeRunUsage(result: unknown): RunUsage | null {
  if (!result || typeof result !== "object") return null;
  const usageRaw = (result as Record<string, unknown>).usage;
  if (!usageRaw || typeof usageRaw !== "object") return null;
  const u = usageRaw as Record<string, unknown>;

  const usage: RunUsage = {
    inputTokens: num(u.inputTokens),
    outputTokens: num(u.outputTokens),
    cachedInputTokens: num(u.cachedInputTokens),
    reasoningOutputTokens: num(u.reasoningOutputTokens),
    cacheCreationInputTokens: num(u.cacheCreationInputTokens),
    totalCostUsd: nullableNum(u.totalCostUsd),
    numTurns: num(u.numTurns),
    durationApiMs: nullableNum(u.durationApiMs),
  };

  return isEmptyRunUsage(usage) ? null : usage;
}

/** 全部 token/次数字段为 0 且没有 cost/耗时信息时视为空，跳过持久化。 */
function isEmptyRunUsage(usage: RunUsage): boolean {
  return (
    usage.inputTokens === 0 &&
    usage.outputTokens === 0 &&
    usage.cachedInputTokens === 0 &&
    usage.reasoningOutputTokens === 0 &&
    usage.cacheCreationInputTokens === 0 &&
    usage.totalCostUsd === null &&
    usage.numTurns === 0 &&
    usage.durationApiMs === null
  );
}

/** 取数值字段：非有限数（含 null/undefined/NaN/string）一律视为 0。 */
function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** 取可空数值：非有限数返回 null（用于 cost 这类「有就有、没有就空」的字段）。 */
function nullableNum(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
