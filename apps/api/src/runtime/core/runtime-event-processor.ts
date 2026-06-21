import { Injectable, Logger } from "@nestjs/common";
import type {
  Envelope,
  RunStatusPayload,
  ControlTracePayload,
} from "@agework/shared/protocol";
import { RunRecordService } from "./run-record.service";
import { normalizeRunUsage } from "./run-usage";
import { RuntimeActiveStore, type RunHandle } from "./runtime-active-store";
import { ConversationService } from "../../conversations/conversation.service";
import { swallow } from "../../common/swallow";
import {
  errorLogFields,
  safeLogJson,
  summarizeEnvelopePayload,
} from "../../common/logging";
import { AgentEventLogService } from "./agent-event-log.service";
import { RunEventRecordService } from "./run-event-record.service";
import type { IncompleteMessageReason } from "./runtime-message-aggregator";

const CHUNK_SAVE_INTERVAL = 20;
/** 终态完成后保留记录的时长，用于阻止 exit handler 等延迟事件覆盖已终态 */
const COMPLETED_RUN_TTL_MS = 5 * 60 * 1000;

@Injectable()
export class RuntimeEventProcessor {
  private readonly logger = new Logger(RuntimeEventProcessor.name);
  private readonly lastSeqMap = new Map<string, number>();
  private readonly chunkCounters = new Map<string, number>();
  /** 防止同一 run 被并发处理多次终态 */
  private readonly finalizingRuns = new Set<string>();
  /** 已完成终态的 run，TTL 后自动清除，用于阻止 exit handler 覆盖 */
  private readonly completedRuns = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly runService: RunRecordService,
    private readonly runRegistry: RuntimeActiveStore,
    private readonly conversationService: ConversationService,
    private readonly agentEventLogService: AgentEventLogService,
    private readonly runEventRecordService: RunEventRecordService
  ) {}

  async publish(envelope: Envelope<unknown>): Promise<void> {
    const { runId, seq } = envelope;
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
          source: "runtime",
          eventType: envelope.type,
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
          source: "runtime",
          eventType: envelope.type,
        })}`
      );
      // gap 只 warn 不可在管理端追溯；落一条摘要事件，使其在 run detail 中可见。
      this.runEventRecordService.record({
        runId,
        seq,
        source: "runtime",
        eventType: "worker.seq_gap",
        level: "warn",
        summary: `expected seq ${expected}, got ${seq}`,
        payload: { expected, got: seq, envelopeType: envelope.type },
      });
    }
    this.lastSeqMap.set(runId, seq);

    switch (envelope.type) {
      case "run.status":
        await this.handleRunStatus(
          runId,
          envelope.payload as RunStatusPayload,
          seq
        );
        break;
      case "heartbeat":
        await this.handleHeartbeat(runId);
        break;
      case "agui.event":
        this.handleAgUiEvent(runId, envelope.payload, seq);
        break;
      case "sdk.raw":
        this.handleSdkRawEvent(runId, envelope.payload, seq);
        break;
      case "control.trace":
        this.recordControlTraceEvent(
          runId,
          envelope.payload as ControlTracePayload,
          seq
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
    payload: RunStatusPayload,
    seq?: number
  ) {
    // 终态 guard：同步检查，在任何 await 之前拦截重复终态
    const isTerminal = ["finished", "error", "cancelled"].includes(
      payload.status
    );
    const statusLogLevel = isTerminal ? "log" : "debug";
    this.logger[statusLogLevel](
      `run status ${safeLogJson({
        runId,
        status: payload.status,
        pendingAction: payload.pendingAction,
        error: payload.error,
      })}`
    );
    if (isTerminal && (this.finalizingRuns.has(runId) || this.completedRuns.has(runId))) {
      this.logger.warn(
        `skip duplicate terminal status ${safeLogJson({
          runId,
          status: payload.status,
        })}`
      );
      return;
    }
    if (isTerminal) {
      this.finalizingRuns.add(runId);
    }
    this.recordRunStatusTraceEvent(runId, payload, seq);

    try {
      const handle = this.runRegistry.get(runId);

      // Update Run record
      switch (payload.status) {
        case "running":
          await this.runService
            .markRunning(runId)
            .catch(swallow(this.logger, `mark run ${runId} running`));
          break;
        case "requires_action":
          await this.runService
            .markRequiresAction(runId)
            .catch(swallow(this.logger, `mark run ${runId} requires_action`));
          // requires_action 不是终态，不会走下方的终态 saveRun。但此时 assistant
          // 消息里已经包含 AskUserQuestion（权限审批/问答）等需要用户交互的 part，
          // 不主动 saveRun 的话这些 part 不会持久化——刷新页面后 messages/list
          // 拿不到这条消息，PendingQuestionPanel 就显示不出来。
          // 这里补一次 saveRun(false) 把当前快照落库。
          handle?.saveRun(false);
          break;
        case "finished":
          await this.runService
            .markFinished(runId)
            .catch(swallow(this.logger, `mark run ${runId} finished`));
          break;
        case "error":
          await this.runService
            .markError(runId, payload.error ?? "unknown error")
            .catch(swallow(this.logger, `mark run ${runId} error`));
          break;
        case "cancelled":
          await this.runService
            .markCancelled(runId)
            .catch(swallow(this.logger, `mark run ${runId} cancelled`));
          break;
      }

      // Update Conversation.pendingUserAction
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

      // Terminal state cleanup
      if (isTerminal && handle) {
        const activeRunStatus = payload.status === "error" ? "error" : "idle";
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
          newerActiveRun !== undefined &&
          (!newerActiveRun || newerActiveRun.id === runId)
        ) {
          await this.conversationService
            .setActiveRunStatus(handle.conversationId, activeRunStatus)
            .catch(
              swallow(
                this.logger,
                `set active run status for conversation ${handle.conversationId}`
              )
            );
        }

        // Final save
        handle.saveRun(
          payload.status === "finished",
          handle.stopReason ?? incompleteReasonForRunStatus(payload.status)
        );

        // End SSE
        if (handle.res && !handle.res.writableEnded) {
          if (handle.streamingSnapshot) {
            // resume 续接模式：推一个终态快照让前端 resume 流收尾
            const finalSnap = handle.aggregator.build(
              payload.status === "finished",
              incompleteReasonForRunStatus(payload.status)
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

        this.runRegistry.unregister(runId);
      }
    } finally {
      if (isTerminal) {
        this.finalizingRuns.delete(runId);
        this.lastSeqMap.delete(runId);
        this.chunkCounters.delete(runId);
      }
    }
  }

  private async handleHeartbeat(runId: string) {
    await this.runService
      .updateHeartbeat(runId)
      .catch(swallow(this.logger, `update heartbeat for run ${runId}`));
  }

  private handleAgUiEvent(runId: string, event: unknown, seq?: number) {
    const handle = this.runRegistry.get(runId);
    if (!handle) {
      this.logger.warn(`drop AG-UI event without active handle ${safeLogJson({ runId })}`);
      return;
    }

    const evt = event as Record<string, unknown>;
    const eventType = typeof evt.type === "string" ? evt.type : "unknown";
    if (shouldLogAgUiEvent(eventType)) {
      this.logger.debug(`forward AG-UI event ${safeLogJson({ runId, type: eventType })}`);
    }
    this.recordAgUiTraceEvent(runId, eventType, seq, evt);
    this.agentEventLogService.writeAgui(handle.agentEventTrace, event);
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
    if (!handle.streamingSnapshot || !handle.res || handle.res.writableEnded) return;
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

  private handleSdkRawEvent(runId: string, event: unknown, seq?: number) {
    const handle = this.runRegistry.get(runId);
    if (!handle) {
      this.logger.debug(`drop raw SDK event without active handle ${safeLogJson({ runId })}`);
      return;
    }
    this.agentEventLogService.writeRaw(handle.agentEventTrace, event);
    this.recordSdkRawTraceEvent(runId, event, seq);
  }

  private recordRunStatusTraceEvent(
    runId: string,
    payload: RunStatusPayload,
    seq?: number
  ): void {
    const level = payload.status === "error" ? "error" : "info";
    const eventType = `run.status.${payload.status}`;
    this.runEventRecordService.record({
      runId,
      seq,
      source: "runtime",
      eventType,
      level,
      summary: payload.error ?? pendingActionSummary(payload.pendingAction),
      payload: {
        status: payload.status,
        phase: payload.phase,
        pendingAction: payload.pendingAction,
        error: payload.error,
      },
    });
  }

  private recordAgUiTraceEvent(
    runId: string,
    eventType: string,
    seq: number | undefined,
    event: Record<string, unknown>
  ): void {
    const trace = aguiTrace(eventType, event);
    if (!trace) return;
    this.runEventRecordService.record({
      runId,
      seq,
      source: "agui",
      ...trace,
    });
  }

  private recordSdkRawTraceEvent(
    runId: string,
    event: unknown,
    seq?: number
  ): void {
    const trace = event as { name?: unknown; threadId?: unknown; payload?: unknown };
    const name = typeof trace?.name === "string" ? trace.name : "sdk.raw";
    const isError = name.toLowerCase().includes("error");
    this.runEventRecordService.record({
      runId,
      seq,
      source: "sdk",
      eventType: name,
      level: isError ? "error" : "debug",
      summary: name,
      payload: {
        name,
        threadId: trace?.threadId,
      },
    });
  }

  /** worker 上报的 control 处理 trace（received/handled/failed），与 API 侧 control.sent 通过 commandId 回连。 */
  private recordControlTraceEvent(
    runId: string,
    payload: ControlTracePayload,
    seq?: number
  ): void {
    const eventType = `control.${payload.phase}`;
    this.runEventRecordService.record({
      runId,
      seq,
      source: "control",
      eventType,
      level: payload.phase === "failed" ? "error" : "info",
      summary: payload.error ?? `${payload.controlType} ${payload.phase}`,
      payload: {
        commandId: payload.commandId,
        controlType: payload.controlType,
        phase: payload.phase,
        error: payload.error,
      },
    });
  }
}

function shouldLogAgUiEvent(eventType: string): boolean {
  return (
    eventType.endsWith("_START") ||
    eventType.endsWith("_END") ||
    eventType === "RUN_STARTED" ||
    eventType === "RUN_ERROR"
  );
}

function incompleteReasonForRunStatus(
  status: RunStatusPayload["status"]
): IncompleteMessageReason | undefined {
  switch (status) {
    case "cancelled":
      return "cancelled";
    case "error":
      return "error";
    default:
      return undefined;
  }
}

function pendingActionSummary(pendingAction: unknown): string | undefined {
  if (!pendingAction || typeof pendingAction !== "object") return undefined;
  const action = pendingAction as { type?: unknown; id?: unknown };
  return [
    typeof action.type === "string" ? action.type : undefined,
    typeof action.id === "string" ? action.id : undefined,
  ]
    .filter(Boolean)
    .join(" / ") || undefined;
}

function aguiTrace(
  eventType: string,
  event: Record<string, unknown>
):
  | {
      eventType: string;
      level?: "debug" | "info" | "warn" | "error";
      summary?: string;
      payload?: unknown;
    }
  | undefined {
  switch (eventType) {
    case "RUN_STARTED":
      return { eventType };
    case "RUN_FINISHED":
      return {
        eventType,
        payload: { outcome: event.outcome, result: event.result },
      };
    case "RUN_ERROR":
      return {
        eventType,
        level: "error",
        summary: stringValue(event.message),
        payload: { message: event.message },
      };
    case "RUN_CANCELLED":
      return { eventType };
    case "TOOL_CALL_START":
      return {
        eventType,
        summary: stringValue(event.toolCallName),
        payload: pickEventFields(event, [
          "toolCallId",
          "toolCallName",
          "parentMessageId",
        ]),
      };
    case "TOOL_CALL_RESULT":
      return {
        eventType,
        summary: contentPreview(event.content),
        payload: {
          ...pickEventFields(event, ["toolCallId", "messageId", "role"]),
          contentPreview: contentPreview(event.content),
        },
      };
    case "TEXT_MESSAGE_START":
      return {
        eventType,
        level: "debug",
        payload: pickEventFields(event, ["messageId", "role"]),
      };
    case "TEXT_MESSAGE_END":
      return {
        eventType,
        level: "debug",
        payload: pickEventFields(event, ["messageId"]),
      };
    case "THINKING_START":
    case "THINKING_TEXT_MESSAGE_START":
    case "REASONING_START":
    case "REASONING_MESSAGE_START":
      return {
        eventType,
        level: "debug",
        payload: pickEventFields(event, ["messageId"]),
      };
    case "THINKING_END":
    case "THINKING_TEXT_MESSAGE_END":
    case "REASONING_END":
    case "REASONING_MESSAGE_END":
      return {
        eventType,
        level: "debug",
        payload: pickEventFields(event, ["messageId"]),
      };
    case "CUSTOM":
      if (event.name === "agent.sessionId" || event.name === "system:init") {
        return {
          eventType: `CUSTOM.${String(event.name)}`,
          summary: stringValue(event.name),
          payload: pickEventFields(event, ["name", "value"]),
        };
      }
      return undefined;
    default:
      return undefined;
  }
}

function pickEventFields(
  event: Record<string, unknown>,
  fields: string[]
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const field of fields) {
    if (event[field] !== undefined) output[field] = event[field];
  }
  return output;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function contentPreview(value: unknown): string | undefined {
  if (typeof value === "string") return value.slice(0, 300);
  if (value === undefined || value === null) return undefined;
  try {
    return JSON.stringify(value).slice(0, 300);
  } catch {
    return String(value).slice(0, 300);
  }
}
