import { Injectable, Logger } from "@nestjs/common";
import type {
  Envelope,
  RunStatusPayload,
  ControlTracePayload,
  RecordRunEventInput,
} from "@agework/shared/protocol";
import { RunRepository } from "../run.repository";
import { normalizeRunUsage } from "./run-usage.mapper";
import { RunActiveStore, type RunHandle } from "./run-active.store";
import { ConversationService } from "../../conversations/conversation.service";
import { swallow } from "../../common/swallow";
import {
  errorLogFields,
  safeLogJson,
  summarizeEnvelopePayload,
} from "../../common/logging";
import { RawEventLogWriter } from "../events/raw-event-log.writer";
import { RunEventRecorder } from "../events/run-event-recorder";
import { decideRunStatusUpdate } from "./run-lifecycle.policy";
import {
  aguiEventFacts,
  controlTraceFact,
  runStatusFact,
  sdkRawErrorFact,
  shouldLogAgUiEvent,
  workerSeqGapFact,
} from "../events/run-event-normalizer";
import { RunExecutionStatusHandler } from "./run-execution-status.handler";

const CHUNK_SAVE_INTERVAL = 20;
/** 终态完成后保留记录的时长，用于阻止 exit handler 等延迟事件覆盖已终态 */
const COMPLETED_RUN_TTL_MS = 5 * 60 * 1000;

@Injectable()
export class RunEnvelopeProcessor {
  private readonly logger = new Logger(RunEnvelopeProcessor.name);
  private readonly lastSeqMap = new Map<string, number>();
  private readonly chunkCounters = new Map<string, number>();
  /** 防止同一 run 被并发处理多次终态 */
  private readonly finalizingRuns = new Set<string>();
  /** 已完成终态的 run，TTL 后自动清除，用于阻止 exit handler 覆盖 */
  private readonly completedRuns = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly runService: RunRepository,
    private readonly runRegistry: RunActiveStore,
    private readonly conversationService: ConversationService,
    private readonly rawEventLogWriter: RawEventLogWriter,
    private readonly runEventRecorder: RunEventRecorder,
    private readonly runExecutionStatusHandler: RunExecutionStatusHandler
  ) {}

  async publish(envelope: Envelope<unknown>): Promise<void> {
    const { runId, seq } = envelope;
    if (
      envelope.type === "run.status" &&
      this.shouldIgnoreRunStatus(
        runId,
        envelope.payload as RunStatusPayload
      )
    ) {
      return;
    }

    const lastSeq = this.lastSeqMap.get(runId) ?? 0;
    this.logger.debug(
      `publish envelope ${safeLogJson({
        runId,
        seq,
        lastSeq,
        type: envelope.type,
        payload: summarizeEnvelopePayload(envelope.payload),
      })}`
    );

    // Dedup: drop if seq <= lastSeq
    if (seq <= lastSeq) {
      this.logger.warn(
        `drop duplicate envelope ${safeLogJson({
          runId,
          seq,
          lastSeq,
          origin: "worker",
          type: envelope.type,
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
          type: envelope.type,
        })}`
      );
      // gap 只 warn 不可在管理端追溯；落一条摘要事件，使其在 run detail 中可见。
      this.recordRunEventFact(
        workerSeqGapFact({
          runId,
          expected,
          got: seq,
          envelopeType: envelope.type,
        }),
        `record worker seq gap for run ${runId}`
      );
    }
    this.lastSeqMap.set(runId, seq);

    switch (envelope.type) {
      case "run.status":
        await this.handleRunStatus(runId, envelope.payload as RunStatusPayload);
        break;
      case "heartbeat":
        await this.handleHeartbeat(runId);
        break;
      case "agui.event":
        await this.handleAgUiEvent(runId, envelope.payload);
        break;
      case "sdk.raw":
        await this.handleSdkRawEvent(runId, envelope.payload);
        break;
      case "control.trace":
        this.recordControlTraceEvent(
          runId,
          envelope.payload as ControlTracePayload
        );
        break;
    }
  }

  /** 强制将 run 标记为终态 error，跳过 seq 去重（worker 异常退出 / 心跳超时场景）。 */
  async forceErrorStatus(runId: string, error: string): Promise<void> {
    await this.handleRunStatus(runId, { status: "error", error });
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
      const handle = this.runRegistry.get(runId);

      // 终态完成后记录 completed，阻止延迟的 exit handler 覆盖。
      // 必须在 saveRun/res.write 等可能抛异常的操作之前设置，
      // 否则异常会跳过 completedRuns.set，导致终态 guard 失效。
      if (isTerminal && !this.completedRuns.has(runId)) {
        const timer = setTimeout(
          () => this.completedRuns.delete(runId),
          COMPLETED_RUN_TTL_MS
        );
        timer.unref();
        this.completedRuns.set(runId, timer);
      }

    await this.runExecutionStatusHandler.apply({
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
        this.runEventRecorder.forgetRun(runId);
      }
    }
  }

  private async handleHeartbeat(runId: string) {
    await this.runService
      .updateHeartbeat(runId)
      .catch(swallow(this.logger, `update heartbeat for run ${runId}`));
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
    const handle = this.runRegistry.get(runId);
    if (!handle) {
      this.logger.warn(
        `drop AG-UI event without active handle ${safeLogJson({ runId })}`
      );
      return;
    }

    const evt = event as Record<string, unknown>;
    const eventType = typeof evt.type === "string" ? evt.type : "unknown";
    if (shouldLogAgUiEvent(eventType)) {
      this.logger.debug(
        `forward AG-UI event ${safeLogJson({ runId, type: eventType })}`
      );
    }
    this.recordAgUiTraceEvent(runId, eventType, evt);
    this.rawEventLogWriter.writeAgui(handle.agentEventTrace, event);
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
    // resume 续接模式（streamingSnapshot）下不转发原始事件，
    // 累积快照在上方节流点统一推送，终态快照由 handleRunStatus 推送。
    if (handle.res && !handle.res.writableEnded && !handle.streamingSnapshot) {
      handle.res.write(`data: ${JSON.stringify(event)}\n\n`);
    }

    // RUN_FINISHED 携带 adapter 上报的 token usage（Claude/Codex 字段名不同），
    // 在转发之后异步归一化并落库，绝不阻塞事件流。
    if (evt.type === "RUN_FINISHED") {
      const usage = normalizeRunUsage(evt.result);
      if (usage) {
        this.runService
          .recordUsage(runId, usage)
          .catch(swallow(this.logger, `record usage for run ${runId}`));
      }
    }
  }

  /**
   * resume 续接模式下，把当前 aggregator 累积快照以 ChatModelRunResult 形态
   * 推给 SSE 连接。仅在 streamingSnapshot=true 且连接存活时推送。
   */
  private writeSnapshotToHandle(handle: RunHandle): void {
    if (!handle.streamingSnapshot || !handle.res || handle.res.writableEnded) {
      return;
    }
    const snap = handle.aggregator.build(false, "streaming");
    if (snap.content.length === 0) return;
    handle.res.write(
      `data: ${JSON.stringify({
        content: snap.content,
        status: snap.status,
        ...(snap.metadata ? { metadata: snap.metadata } : {}),
      })}\n\n`
    );
  }

  private async handleSdkRawEvent(runId: string, event: unknown) {
    const handle = this.runRegistry.get(runId);
    if (!handle) {
      this.logger.debug(
        `drop raw SDK event without active handle ${safeLogJson({ runId })}`
      );
      return;
    }
    this.rawEventLogWriter.writeRaw(handle.agentEventTrace, event);
    this.recordSdkRawTraceEvent(runId, event);
  }

  private recordRunStatusTraceEvent(
    runId: string,
    payload: RunStatusPayload
  ): void {
    this.recordRunEventFact(
      runStatusFact(runId, payload),
      `record run status event for run ${runId}`
    );
  }

  private recordAgUiTraceEvent(
    runId: string,
    eventType: string,
    event: Record<string, unknown>
  ): void {
    const facts = aguiEventFacts(runId, eventType, event);
    for (const fact of facts) {
      this.recordRunEventFact(
        fact,
        `record AG-UI event ${eventType} for run ${runId}`
      );
    }
  }

  private recordSdkRawTraceEvent(
    runId: string,
    event: unknown
  ): void {
    this.recordRunEventFact(
      sdkRawErrorFact(runId, event),
      `record raw SDK error event for run ${runId}`
    );
  }

  /** worker 上报的 control 处理 trace（received/handled/failed），与 API 侧 control.sent 通过 commandId 回连。 */
  private recordControlTraceEvent(
    runId: string,
    payload: ControlTracePayload
  ): void {
    this.recordRunEventFact(
      controlTraceFact(runId, payload),
      `record control trace for run ${runId}`
    );
  }

  private recordRunEventFact(
    fact: RecordRunEventInput | undefined,
    context: string
  ): void {
    if (!fact) return;
    this.runEventRecorder
      .append(fact)
      .catch(swallow(this.logger, context));
  }
}
