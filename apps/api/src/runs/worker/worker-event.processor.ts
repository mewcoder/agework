import { Injectable, Logger } from "@nestjs/common";
import type {
  RunChannelMessage,
  RunStatusPayload,
  CommandResultPayload,
  CommandTracePayload,
  RecordRunEventInput,
  RunUsage,
  WorkerExecutionHandle,
} from "@agework/shared/protocol";
import { RunRepository } from "../run.repository";
import {
  ActiveRunRegistry,
  type RunHandle,
  type RunTimeoutErrorSink,
} from "../lifecycle/active-run.registry";
import { RunDriver } from "./run-driver";
import { ConversationService } from "../../conversations/conversation.service";
import { swallow } from "../../common/swallow";
import {
  errorLogFields,
  safeLogJson,
  summarizeMessagePayload,
} from "../../common/logging";
import { AgentEventTraceWriter } from "../events/agent-event-trace.writer";
import { RunEventService } from "../events/run-event.service";
import { decideRunStatusUpdate } from "../lifecycle/run-status.policy";
import { RunStatusService } from "../lifecycle/run-status.service";

const CHUNK_SAVE_INTERVAL = 20;
/** 终态完成后保留记录的时长，用于阻止 exit handler 等延迟事件覆盖已终态 */
const COMPLETED_RUN_TTL_MS = 5 * 60 * 1000;

@Injectable()
export class WorkerEventProcessor implements RunTimeoutErrorSink {
  private readonly logger = new Logger(WorkerEventProcessor.name);
  private readonly lastSeqMap = new Map<string, number>();
  private readonly chunkCounters = new Map<string, number>();
  /** 防止同一 run 被并发处理多次终态 */
  private readonly finalizingRuns = new Set<string>();
  /** 已完成终态的 run，TTL 后自动清除，用于阻止 exit handler 覆盖 */
  private readonly completedRuns = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly runRepository: RunRepository,
    private readonly activeRuns: ActiveRunRegistry,
    private readonly conversationService: ConversationService,
    private readonly eventTraceWriter: AgentEventTraceWriter,
    private readonly runEvents: RunEventService,
    private readonly runStatusService: RunStatusService,
    private readonly runDriver: RunDriver
  ) {}

  async publish(message: RunChannelMessage<unknown>): Promise<void> {
    const { runId, seq } = message;
    if (
      message.type === "run.status" &&
      this.shouldIgnoreRunStatus(
        runId,
        message.payload as RunStatusPayload
      )
    ) {
      return;
    }

    const lastSeq = this.lastSeqMap.get(runId) ?? 0;
    this.logger.debug(
      `publish message ${safeLogJson({
        runId,
        seq,
        lastSeq,
        type: message.type,
        payload: summarizeMessagePayload(message.payload),
      })}`
    );

    // Dedup: drop if seq <= lastSeq
    if (seq <= lastSeq) {
      this.logger.warn(
        `drop duplicate message ${safeLogJson({
          runId,
          seq,
          lastSeq,
          origin: "worker",
          type: message.type,
        })}`
      );
      return;
    }
    if (seq > lastSeq + 1) {
      const expected = lastSeq + 1;
      this.logger.warn(
        `seq gap detected ${safeLogJson({
          runId,
          expected,
          got: seq,
          origin: "worker",
          type: message.type,
        })}`
      );
      // gap 只 warn 不可在管理端追溯；落一条摘要事件，使其在 run detail 中可见。
      this.recordRunEvent(
        this.runEvents.fromWorkerSeqGap({
          runId,
          expected,
          got: seq,
          messageType: message.type,
        }),
        `record worker seq gap for run ${runId}`
      );
    }
    this.lastSeqMap.set(runId, seq);

    switch (message.type) {
      case "run.status":
        await this.handleRunStatus(runId, message.payload as RunStatusPayload);
        break;
      case "agui.event":
        await this.handleAgUiEvent(runId, message.payload);
        break;
      case "sdk.raw":
        await this.handleSdkRawEvent(runId, message.payload);
        break;
      case "command.trace":
        this.recordCommandTraceEvent(
          runId,
          message.payload as CommandTracePayload
        );
        break;
      case "command.result":
        this.recordCommandResultEvent(
          runId,
          message.payload as CommandResultPayload
        );
        break;
    }
  }

  /** 强制将 run 标记为终态 error，跳过 seq 去重（worker 异常退出 / run 超时场景）。 */
  async forceErrorStatus(runId: string, error: string): Promise<void> {
    await this.handleRunStatus(runId, { status: "error", error });
  }

  async markRunTimedOut(
    runId: string,
    runtimeHandle: WorkerExecutionHandle
  ): Promise<void> {
    try {
      await this.forceErrorStatus(runId, "run timeout");
    } finally {
      this.runDriver.terminateExecution(runtimeHandle, "run timeout");
    }
  }

  /** 强制将 run 标记为终态 cancelled，跳过 seq 去重（启动中取消且 worker 尚未上报场景）。 */
  async forceCancelledStatus(runId: string): Promise<void> {
    await this.handleRunStatus(runId, { status: "cancelled" });
  }

  /** run 是否已在终态处理中或已完成终态（供 provider 的 exit handler 判断是否跳过 error 发布）。 */
  isTerminalOrFinalizing(runId: string): boolean {
    return this.finalizingRuns.has(runId) || this.completedRuns.has(runId);
  }

  private async handleRunStatus(
    runId: string,
    payload: RunStatusPayload
  ) {
    const decision = decideRunStatusUpdate({
      nextStatus: payload.status,
      terminalOrFinalizing: this.isTerminalOrFinalizing(runId),
    });
    if (decision.action === "ignore") {
      this.logIgnoredRunStatus(runId, payload);
      return;
    }
    const effect = decision.effect;
    const isTerminal = effect.isTerminal;
    const statusLogLevel = isTerminal ? "log" : "debug";
    this.logger[statusLogLevel](
      `run status ${safeLogJson({
        runId,
        status: payload.status,
        pendingAction: payload.pendingAction,
        error: payload.error,
      })}`
    );
    if (isTerminal) {
      this.finalizingRuns.add(runId);
    }
    this.recordRunStatusTraceEvent(runId, payload);

    try {
      const handle = this.activeRuns.get(runId);

      // 终态完成后记录 completed，阻止延迟的 exit handler 覆盖。
      // 必须在 saveRun/stream write 等可能抛异常的操作之前设置，
      // 否则异常会跳过 completedRuns.set，导致终态 guard 失效。
      if (isTerminal && !this.completedRuns.has(runId)) {
        const timer = setTimeout(
          () => this.completedRuns.delete(runId),
          COMPLETED_RUN_TTL_MS
        );
        timer.unref();
        this.completedRuns.set(runId, timer);
      }

      await this.runStatusService.apply({
        runId,
        payload,
        effect,
        handle,
      });
    } finally {
      if (isTerminal) {
        this.finalizingRuns.delete(runId);
        this.lastSeqMap.delete(runId);
        this.chunkCounters.delete(runId);
        this.runEvents.forgetRun(runId);
      }
    }
  }

  private shouldIgnoreRunStatus(
    runId: string,
    payload: RunStatusPayload
  ): boolean {
    const decision = decideRunStatusUpdate({
      nextStatus: payload.status,
      terminalOrFinalizing: this.isTerminalOrFinalizing(runId),
    });
    if (decision.action === "apply") return false;
    this.logIgnoredRunStatus(runId, payload);
    return true;
  }

  private logIgnoredRunStatus(runId: string, payload: RunStatusPayload): void {
    this.logger.warn(
      `skip run status after terminal ${safeLogJson({
        runId,
        status: payload.status,
        pendingAction: payload.pendingAction,
        error: payload.error,
      })}`
    );
  }

  private async handleAgUiEvent(runId: string, event: unknown) {
    const handle = this.activeRuns.get(runId);
    if (!handle) {
      this.logger.warn(
        `drop AG-UI event without active handle ${safeLogJson({ runId })}`
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
    this.recordAgUiTraceEvent(runId, eventType, evt);
    if (!handle.agentEventTrace?.aguiRuntimeFilePath) {
      this.eventTraceWriter.writeAgui(handle.agentEventTrace, event);
    }
    handle.aggregator.handle(evt as { type: string; [key: string]: unknown });

    // Chunk-based save throttle（兼 resume 快照推送节流）
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

    // Handle CUSTOM events for agent session ID
    if (evt.type === "CUSTOM" && handle.conversationId) {
      if (evt.name === "agent.sessionId" && typeof evt.value === "string") {
        handle.onAgentSessionId?.(evt.value);
        this.conversationService
          .setAgentSessionId(handle.conversationId, evt.value)
          .catch(
            (err) =>
              this.logger.warn(
                `persist agent session id failed ${safeLogJson({
                  conversationId: handle.conversationId,
                  ...errorLogFields(err),
                })}`
              )
          );
        return; // Don't forward to SSE
      }
      if (evt.name === "system:init") {
        const value = evt.value as { session_id?: unknown } | undefined;
        if (typeof value?.session_id === "string") {
          handle.onAgentSessionId?.(value.session_id);
          this.conversationService
            .setAgentSessionId(handle.conversationId, value.session_id)
            .catch(
              (err) =>
                this.logger.warn(
                  `persist agent session id failed ${safeLogJson({
                    conversationId: handle.conversationId,
                    ...errorLogFields(err),
                  })}`
                )
            );
        }
      }
    }

    // MESSAGES_SNAPSHOT is only used for server-side aggregation/persistence;
    // forwarding it would duplicate messages already built incrementally on the client
    if (evt.type === "MESSAGES_SNAPSHOT") return;
    // RUN_CANCELLED is not part of the AG-UI client event schema used by the web runtime.
    // Keep it for server-side aggregation/diagnostics only; run.status=cancelled performs terminal cleanup.
    if (evt.type === "RUN_CANCELLED") return;

    // Write to SSE
    // resume 续接模式下不转发原始事件，
    // 累积快照在上方节流点统一推送，终态快照由 handleRunStatus 推送。
    if (!handle.stream.isSnapshotMode) {
      handle.stream.writeEvent(event);
    }

    // RUN_FINISHED 携带 adapter 上报的 token usage（Claude/Codex 字段名不同），
    // 在转发之后异步归一化并落库，绝不阻塞事件流。
    if (evt.type === "RUN_FINISHED") {
      const usage = normalizeRunUsage(evt.result);
      if (usage) {
        this.runRepository
          .recordUsage(runId, usage)
          .catch(swallow(this.logger, `record usage for run ${runId}`));
      }
    }
  }

  /**
   * resume 续接模式下，把当前 aggregator 累积快照以 ChatModelRunResult 形态
   * 推给 SSE 连接。仅在快照模式且连接存活时推送。
   */
  private writeSnapshotToHandle(handle: RunHandle): void {
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

  private async handleSdkRawEvent(runId: string, event: unknown) {
    const handle = this.activeRuns.get(runId);
    if (!handle) {
      this.logger.debug(
        `drop raw SDK event without active handle ${safeLogJson({ runId })}`
      );
      return;
    }
    this.eventTraceWriter.writeRaw(handle.agentEventTrace, event);
    this.recordSdkRawTraceEvent(runId, event);
  }

  private recordRunStatusTraceEvent(
    runId: string,
    payload: RunStatusPayload
  ): void {
    this.recordRunEvent(
      this.runEvents.fromRunStatusPayload(runId, payload),
      `record run status event for run ${runId}`
    );
  }

  private recordAgUiTraceEvent(
    runId: string,
    eventType: string,
    event: Record<string, unknown>
  ): void {
    const events = this.runEvents.fromAgUiEvent(runId, eventType, event);
    for (const event of events) {
      this.recordRunEvent(
        event,
        `record AG-UI event ${eventType} for run ${runId}`
      );
    }
  }

  private recordSdkRawTraceEvent(
    runId: string,
    event: unknown
  ): void {
    this.recordRunEvent(
      this.runEvents.fromSdkRawEvent(runId, event),
      `record raw SDK error event for run ${runId}`
    );
  }

  /** worker 上报的 command 处理 trace（received/handled/failed），与 API 侧 command.sent 通过 commandId 回连。 */
  private recordCommandTraceEvent(
    runId: string,
    payload: CommandTracePayload
  ): void {
    this.recordRunEvent(
      this.runEvents.fromCommandTrace(runId, payload),
      `record command trace for run ${runId}`
    );
  }

  private recordCommandResultEvent(
    runId: string,
    payload: CommandResultPayload
  ): void {
    this.recordRunEvent(
      this.runEvents.fromCommandResult(runId, payload),
      `record command result for run ${runId}`
    );
  }

  private recordRunEvent(
    event: RecordRunEventInput | undefined,
    context: string
  ): void {
    if (!event) return;
    this.runEvents
      .append(event)
      .catch(swallow(this.logger, context));
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
