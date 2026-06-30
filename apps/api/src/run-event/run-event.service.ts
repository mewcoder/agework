import { Injectable, Logger } from "@nestjs/common";
import type {
  CommandResultPayload,
  CommandTracePayload,
  RecordRunEventInput,
  RunEventData,
  RunEventOrigin,
  RunEventRecord,
  RunEventRefs,
  RunEventTargetType,
  RunStatusPayload,
} from "@agework/shared/protocol";
import { errorLogFields, safeLogJson } from "../common/logging";
import { RunEventRepository } from "./run-event.repository";

type RunEventBase = {
  runId: string;
  eventKey?: string;
  targetType?: RunEventTargetType;
  targetId?: string;
  chainId?: string;
  refs?: RunEventRefs;
  summary?: string;
  data?: RunEventData;
};

/**
 * Structured run event boundary: builds semantic events, normalizes worker traces,
 * and appends them with per-run sequence allocation.
 */
@Injectable()
export class RunEventService {
  private readonly logger = new Logger(RunEventService.name);
  private readonly runSeqCounters = new Map<string, number>();
  private readonly runLocks = new Map<string, Promise<unknown>>();

  constructor(private readonly repository: RunEventRepository) {}

  /** 管理端：按 run 查询事件（读路径，委托 Repository）。 */
  listForAdmin(params: Parameters<RunEventRepository["listAdminEvents"]>[0]) {
    return this.repository.listAdminEvents(params);
  }

  /**
   * Per-run seq is allocated in-process for the single API instance deployment.
   * Multi-instance deployment must move seq allocation into RunEventRepository/DB.
   */
  append(event: RecordRunEventInput): Promise<RunEventRecord> {
    return this.withRunLock(event.runId, async () => {
      if (!this.runSeqCounters.has(event.runId)) {
        this.runSeqCounters.set(
          event.runId,
          await this.repository.maxRunSeq(event.runId)
        );
      }

      const runSeq = (this.runSeqCounters.get(event.runId) ?? 0) + 1;
      this.runSeqCounters.set(event.runId, runSeq);

      try {
        return await this.repository.insertOrGetByEventKey({
          ...event,
          runSeq,
        });
      } catch (err) {
        this.logger.warn(
          `append run event failed ${safeLogJson({
            runId: event.runId,
            type: event.type,
            ...errorLogFields(err),
          })}`
        );
        throw err;
      }
    });
  }

  forgetRun(runId: string): void {
    this.runSeqCounters.delete(runId);
  }

  runCreated(input: {
    runId: string;
    conversationId: string;
    workspaceId?: string;
    agentType: string;
    runtimeType: string;
    /**
     * 隔离粒度，仅 sandbox run 有值（user/workspace）。
     * local run 无容器隔离语义，此字段为 undefined。
     */
    isolationScope?: string;
  }): RecordRunEventInput {
    return {
      runId: input.runId,
      type: "run.created",
      origin: "platform",
      targetType: "run",
      targetId: input.runId,
      chainId: input.runId,
      refs: { conversationId: input.conversationId },
      summary: "Run created",
      data: compactData({
        component: "api",
        workspaceId: input.workspaceId,
        agentType: input.agentType,
        runtimeType: input.runtimeType,
        isolationScope: input.isolationScope,
      }),
    };
  }

  runStatusChanged(input: {
    runId: string;
    origin?: RunEventOrigin;
    status: RunStatusPayload["status"];
    phase?: string;
    pendingAction?: unknown;
    error?: string;
    reason?: string;
  }): RecordRunEventInput {
    return {
      runId: input.runId,
      type: "run.status_changed",
      origin: input.origin ?? "worker",
      targetType: "run",
      targetId: input.runId,
      summary: input.error ?? input.reason,
      data: compactData({
        status: input.status,
        phase: input.phase,
        pendingAction: input.pendingAction,
        error: input.error,
        reason: input.reason,
      }),
    };
  }

  runtimeStatusChanged(
    input: RunEventBase & {
      status: string;
      runtimeType?: string;
      runtimeInstanceId?: string;
      isolationScope?: string;
      sandboxEngineType?: string;
      error?: string;
    }
  ): RecordRunEventInput {
    return {
      runId: input.runId,
      eventKey: input.eventKey,
      type: "runtime.status_changed",
      origin: "platform",
      targetType: "runtime",
      targetId: input.targetId,
      chainId: input.chainId,
      refs: input.refs,
      summary: input.summary ?? input.error,
      data: compactData({
        status: input.status,
        runtimeType: input.runtimeType,
        runtimeInstanceId: input.runtimeInstanceId,
        isolationScope: input.isolationScope,
        sandboxEngineType: input.sandboxEngineType,
        error: input.error,
        ...input.data,
      }),
    };
  }

  messageAccepted(input: {
    runId: string;
    messageId: string;
    conversationId: string;
    userId?: string;
  }): RecordRunEventInput {
    return {
      runId: input.runId,
      eventKey: `message:${input.messageId}:accepted`,
      type: "message.accepted",
      origin: "platform",
      targetType: "message",
      targetId: input.messageId,
      chainId: input.messageId,
      refs: {
        messageId: input.messageId,
        conversationId: input.conversationId,
        userId: input.userId,
      },
      summary: "User message accepted",
      data: { role: "user" },
    };
  }

  commandSent(input: {
    runId: string;
    commandId: string;
    commandType: string;
  }): RecordRunEventInput {
    return {
      runId: input.runId,
      eventKey: `command:${input.commandId}:command.sent`,
      type: "command.sent",
      origin: "platform",
      targetType: "command",
      targetId: input.commandId,
      chainId: input.commandId,
      refs: { commandId: input.commandId },
      summary: `${input.commandType} sent`,
      data: compactData({
        component: "api",
        commandType: input.commandType,
      }),
    };
  }

  commandHandled(input: {
    runId: string;
    commandId: string;
    commandType: string;
    phase: "received" | "handled";
  }): RecordRunEventInput {
    return {
      runId: input.runId,
      eventKey: `command:${input.commandId}:${input.phase}`,
      type: "command.handled",
      origin: "worker",
      targetType: "command",
      targetId: input.commandId,
      chainId: input.commandId,
      refs: { commandId: input.commandId },
      summary: `${input.commandType} ${input.phase}`,
      data: { commandType: input.commandType, phase: input.phase },
    };
  }

  commandFailed(input: {
    runId: string;
    commandId: string;
    commandType: string;
    error?: string;
  }): RecordRunEventInput {
    return {
      runId: input.runId,
      eventKey: `command:${input.commandId}:failed`,
      type: "command.failed",
      origin: "worker",
      targetType: "command",
      targetId: input.commandId,
      chainId: input.commandId,
      refs: { commandId: input.commandId },
      summary: input.error ?? `${input.commandType} failed`,
      data: compactData({
        commandType: input.commandType,
        phase: "failed",
        error: input.error,
      }),
    };
  }

  commandResult(input: {
    runId: string;
    commandId: string;
    commandType: string;
    status: "ok" | "error";
    error?: string;
  }): RecordRunEventInput {
    return {
      runId: input.runId,
      eventKey: `command:${input.commandId}:result`,
      type: "command.result",
      origin: "worker",
      targetType: "command",
      targetId: input.commandId,
      chainId: input.commandId,
      refs: { commandId: input.commandId },
      summary:
        input.status === "ok"
          ? `${input.commandType} ok`
          : (input.error ?? `${input.commandType} error`),
      data: compactData({
        commandType: input.commandType,
        status: input.status,
        error: input.error,
      }),
    };
  }

  messageStarted(input: {
    runId: string;
    messageId?: string;
    role?: string;
  }): RecordRunEventInput | undefined {
    if (!input.messageId) return undefined;
    return {
      runId: input.runId,
      eventKey: `message:${input.messageId}:started`,
      type: "message.started",
      origin: "agent",
      targetType: "message",
      targetId: input.messageId,
      chainId: input.messageId,
      refs: { messageId: input.messageId },
      data: compactData({ role: input.role }),
    };
  }

  messageCompleted(input: {
    runId: string;
    messageId?: string;
  }): RecordRunEventInput | undefined {
    if (!input.messageId) return undefined;
    return {
      runId: input.runId,
      eventKey: `message:${input.messageId}:completed`,
      type: "message.completed",
      origin: "agent",
      targetType: "message",
      targetId: input.messageId,
      chainId: input.messageId,
      refs: { messageId: input.messageId },
    };
  }

  toolStarted(input: {
    runId: string;
    toolCallId?: string;
    toolName?: string;
    parentMessageId?: string;
  }): RecordRunEventInput | undefined {
    if (!input.toolCallId) return undefined;
    return {
      runId: input.runId,
      eventKey: `tool:${input.toolCallId}:started`,
      type: "tool.started",
      origin: "agent",
      targetType: "tool_call",
      targetId: input.toolCallId,
      chainId: input.toolCallId,
      refs: {
        toolCallId: input.toolCallId,
        parentMessageId: input.parentMessageId,
      },
      summary: input.toolName,
      data: compactData({ toolName: input.toolName }),
    };
  }

  toolCompleted(input: {
    runId: string;
    toolCallId?: string;
    messageId?: string;
    contentPreview?: string;
  }): RecordRunEventInput | undefined {
    if (!input.toolCallId) return undefined;
    return {
      runId: input.runId,
      eventKey: `tool:${input.toolCallId}:completed`,
      type: "tool.completed",
      origin: "worker",
      targetType: "tool_call",
      targetId: input.toolCallId,
      chainId: input.toolCallId,
      refs: {
        toolCallId: input.toolCallId,
        messageId: input.messageId,
      },
      summary: input.contentPreview,
      data: compactData({ contentPreview: input.contentPreview }),
    };
  }

  toolFailed(input: {
    runId: string;
    toolCallId?: string;
    messageId?: string;
    error?: string;
    contentPreview?: string;
  }): RecordRunEventInput | undefined {
    if (!input.toolCallId) return undefined;
    return {
      runId: input.runId,
      eventKey: `tool:${input.toolCallId}:failed`,
      type: "tool.failed",
      origin: "worker",
      targetType: "tool_call",
      targetId: input.toolCallId,
      chainId: input.toolCallId,
      refs: {
        toolCallId: input.toolCallId,
        messageId: input.messageId,
      },
      summary: input.error ?? input.contentPreview,
      data: compactData({
        error: input.error,
        contentPreview: input.contentPreview,
      }),
    };
  }

  systemIssue(
    input: RunEventBase & {
      code: string;
      message?: string;
      origin?: RunEventOrigin;
      severity?: "warn" | "error";
    }
  ): RecordRunEventInput {
    return {
      runId: input.runId,
      eventKey: input.eventKey,
      type: "system.issue",
      origin: input.origin ?? "platform",
      targetType: input.targetType,
      targetId: input.targetId,
      chainId: input.chainId,
      refs: input.refs,
      summary: input.summary ?? input.message,
      data: compactData({
        code: input.code,
        message: input.message,
        severity: input.severity,
        ...input.data,
      }),
    };
  }

  fromWorkerSeqGap(input: {
    runId: string;
    expected: number;
    got: number;
    messageType: string;
  }): RecordRunEventInput {
    return this.systemIssue({
      runId: input.runId,
      code: "worker_seq_gap",
      origin: "worker",
      severity: "warn",
      summary: `expected seq ${input.expected}, got ${input.got}`,
      data: {
        expected: input.expected,
        got: input.got,
        messageType: input.messageType,
      },
    });
  }

  fromRunStatusPayload(
    runId: string,
    payload: RunStatusPayload
  ): RecordRunEventInput {
    return this.runStatusChanged({
      runId,
      status: payload.status,
      phase: payload.phase,
      pendingAction: payload.pendingAction,
      error: payload.error,
      reason: pendingActionSummary(payload.pendingAction),
    });
  }

  shouldLogAgUiEvent(eventType: string): boolean {
    return (
      eventType.endsWith("_START") ||
      eventType.endsWith("_END") ||
      eventType === "RUN_STARTED" ||
      eventType === "RUN_ERROR"
    );
  }

  fromAgUiEvent(
    runId: string,
    eventType: string,
    event: Record<string, unknown>
  ): RecordRunEventInput[] {
    const events: RecordRunEventInput[] = [];
    switch (eventType) {
      case "RUN_ERROR":
        events.push(
          this.systemIssue({
            runId,
            code: "agui_run_error",
            origin: "agent",
            severity: "error",
            summary: stringValue(event.message),
            message: stringValue(event.message),
          })
        );
        break;
      case "TOOL_CALL_START":
        pushEvent(
          events,
          this.toolStarted({
            runId,
            toolCallId: stringValue(event.toolCallId),
            toolName: stringValue(event.toolCallName),
            parentMessageId: stringValue(event.parentMessageId),
          })
        );
        break;
      case "TOOL_CALL_RESULT": {
        const preview = contentPreview(event.content);
        const error = toolResultError(event, preview);
        pushEvent(
          events,
          error
            ? this.toolFailed({
                runId,
                toolCallId: stringValue(event.toolCallId),
                messageId: stringValue(event.messageId),
                error,
                contentPreview: preview,
              })
            : this.toolCompleted({
                runId,
                toolCallId: stringValue(event.toolCallId),
                messageId: stringValue(event.messageId),
                contentPreview: preview,
              })
        );
        break;
      }
      case "TEXT_MESSAGE_START":
        pushEvent(
          events,
          this.messageStarted({
            runId,
            messageId: stringValue(event.messageId),
            role: stringValue(event.role),
          })
        );
        break;
      case "TEXT_MESSAGE_END":
        pushEvent(
          events,
          this.messageCompleted({
            runId,
            messageId: stringValue(event.messageId),
          })
        );
        break;
      default:
        break;
    }
    return events;
  }

  fromSdkRawEvent(
    runId: string,
    event: unknown
  ): RecordRunEventInput | undefined {
    const trace = event as { name?: unknown; threadId?: unknown };
    const name = typeof trace?.name === "string" ? trace.name : "sdk.raw";
    const isError = name.toLowerCase().includes("error");
    if (!isError) return undefined;
    const threadId = stringValue(trace?.threadId);
    return this.systemIssue({
      runId,
      code: "sdk_error",
      origin: "agent",
      summary: name,
      data: {
        providerEventName: name,
        ...(threadId ? { threadId } : {}),
      },
    });
  }

  fromCommandTrace(
    runId: string,
    payload: CommandTracePayload
  ): RecordRunEventInput {
    return payload.phase === "failed"
      ? this.commandFailed({
          runId,
          commandId: payload.commandId,
          commandType: payload.commandType,
          error: payload.error,
        })
      : this.commandHandled({
          runId,
          commandId: payload.commandId,
          commandType: payload.commandType,
          phase: payload.phase,
        });
  }

  fromCommandResult(
    runId: string,
    payload: CommandResultPayload
  ): RecordRunEventInput {
    return this.commandResult({
      runId,
      commandId: payload.commandId,
      commandType: payload.commandType,
      status: payload.status,
      error: payload.error,
    });
  }

  private withRunLock<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.runLocks.get(runId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(fn);
    const stored = next.catch(() => undefined);
    this.runLocks.set(runId, stored);
    stored.finally(() => {
      if (this.runLocks.get(runId) === stored) {
        this.runLocks.delete(runId);
      }
    });
    return next;
  }
}

export function compactData(input: Record<string, unknown>): RunEventData {
  const output: RunEventData = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) {
      output[key] = jsonSafe(value);
    }
  }
  return output;
}

function jsonSafe(value: unknown): RunEventData[string] {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(jsonSafe);
  }
  if (typeof value === "object") {
    const output: RunEventData = {};
    for (const [key, child] of Object.entries(
      value as Record<string, unknown>
    )) {
      if (child !== undefined) output[key] = jsonSafe(child);
    }
    return output;
  }
  // 残余类型(bigint / symbol / function)非 JSON 值,统一转字符串保留可读信息;
  // 此处不会是普通对象(已在上面 object 分支处理),no-base-to-string 是误报。
  // eslint-disable-next-line @typescript-eslint/no-base-to-string
  return String(value);
}

function pendingActionSummary(pendingAction: unknown): string | undefined {
  if (typeof pendingAction === "string") return pendingAction;
  if (!pendingAction || typeof pendingAction !== "object") return undefined;
  const action = pendingAction as { type?: unknown; id?: unknown };
  return (
    [
      typeof action.type === "string" ? action.type : undefined,
      typeof action.id === "string" ? action.id : undefined,
    ]
      .filter(Boolean)
      .join(" / ") || undefined
  );
}

function pushEvent<T>(events: T[], event: T | undefined): void {
  if (event) {
    events.push(event);
  }
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
    // 循环引用等无法序列化:回退到稳定标记,避免 "[object Object]"。
    return "[unserializable]";
  }
}

function toolResultError(
  event: Record<string, unknown>,
  preview: string | undefined
): string | undefined {
  const directError =
    stringValue(event.error) ?? stringValue(event.errorMessage);
  if (directError) return directError;

  const contentError = errorFromContent(event.content);
  if (contentError) return contentError;

  const status = stringValue(event.status)?.toLowerCase();
  const failed =
    event.isError === true ||
    event.error === true ||
    status === "error" ||
    status === "failed";
  if (failed)
    return stringValue(event.message) ?? preview ?? "tool call failed";
  return undefined;
}

function errorFromContent(value: unknown): string | undefined {
  if (typeof value === "string") {
    try {
      return errorFromContent(JSON.parse(value));
    } catch {
      return undefined;
    }
  }
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const explicitError =
    stringValue(record.error) ?? stringValue(record.errorMessage);
  if (explicitError) return explicitError;

  const status = stringValue(record.status)?.toLowerCase();
  if (record.isError === true || status === "error" || status === "failed") {
    return stringValue(record.message);
  }
  return undefined;
}
