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
import { errorLogFields } from "../common/logging";
import { RunEventRepository } from "./run-event.repository";
import { RunEventSeqStore } from "./seq/run-event-seq.store";
import { RawJsonlReader } from "./raw/raw-jsonl-reader";

type RunEventBase = {
  runId: string;
  eventKey?: string;
  targetType?: RunEventTargetType;
  targetId?: string;
  chainId?: string;
  refs?: RunEventRefs;
  summary?: string;
  /** 附加明细,builder 内部统一 compactData 规范化,调用方传原始对象即可。 */
  data?: Record<string, unknown>;
};

/**
 * Structured run event boundary: builds semantic events, normalizes worker traces,
 * and appends them with per-run sequence allocation.
 */
@Injectable()
export class RunEventService {
  private readonly logger = new Logger(RunEventService.name);

  constructor(
    private readonly repository: RunEventRepository,
    private readonly seqStore: RunEventSeqStore,
    private readonly rawJsonlReader: RawJsonlReader
  ) {}

  /** 管理端：按 run 查询事件（读路径，委托 Repository；分页信封在此收口）。 */
  async listForAdmin(
    params: Parameters<RunEventRepository["listAdminEvents"]>[0]
  ) {
    const { list, total } = await this.repository.listAdminEvents(params);
    return { list, total, ...pageEnvelope(params) };
  }

  /** 管理端：按 run 查询本地 raw/agui JSONL 流水（读路径，委托 RawJsonlReader；分页信封在此收口）。 */
  listRawForAdmin(params: Parameters<RawJsonlReader["listForAdmin"]>[0]) {
    const { list, total } = this.rawJsonlReader.listForAdmin(params);
    return { list, total, ...pageEnvelope(params) };
  }

  /**
   * 持久化一条结构化 run event：委托 RunEventSeqStore 按 runId 串行分配单调 runSeq，
   * 再落库；`eventKey` 冲突时幂等返回已存在的记录。
   */
  append(event: RecordRunEventInput): Promise<RunEventRecord> {
    return this.seqStore.withNextSeq(event.runId, async (runSeq) => {
      try {
        return await this.repository.insertOrGetByEventKey({
          ...event,
          runSeq,
        });
      } catch (err) {
        this.logger.warn("append run event failed", {
          runId: event.runId,
          type: event.type,
          ...errorLogFields(err),
        });
        throw err;
      }
    });
  }

  /** run 终态 cleanup：丢弃该 run 缓存的 seq 游标（委托 RunEventSeqStore）。 */
  forgetRun(runId: string): void {
    this.seqStore.forget(runId);
  }

  /** 构建 run.created 事件：run 创建时记录 agent/runtime 类型与复用范围。 */
  runCreated(input: {
    runId: string;
    conversationId: string;
    workspaceId?: string;
    agentType: string;
    runtimeType: string;
    /** Worker 复用范围（user/workspace）；native 固定为 workspace。 */
    scope: string;
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
        scope: input.scope,
      }),
    };
  }

  /** 构建 run.status_changed 事件：记录 run 状态迁移、阶段与待处理动作。 */
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

  /** 构建 runtime.status_changed 事件：记录 runtimeType 的状态与 scope 信息。 */
  runtimeStatusChanged(
    input: RunEventBase & {
      status: string;
      runtimeType?: string;
      scope?: string;
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
        scope: input.scope,
        error: input.error,
        ...input.data,
      }),
    };
  }

  /** 构建 message.accepted 事件：记录用户消息被平台接收。 */
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

  /** 构建 command.sent 事件：记录平台向 worker 下发的命令。 */
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

  /** 构建 command.handled 事件：记录 worker 收到/处理命令的阶段。 */
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

  /** 构建 command.failed 事件：记录命令在 worker 侧执行失败。 */
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

  /** 构建 command.result 事件：记录命令的最终执行结果（ok/error）。 */
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

  /** 构建 message.started 事件：agent 开始输出消息；缺少 messageId 时不产生事件。 */
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

  /** 构建 message.completed 事件：agent 消息输出完成；缺少 messageId 时不产生事件。 */
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

  /** 构建 message.failed 事件：assistant 消息未完成 run 即终止(error/cancelled)；缺少 messageId 时不产生事件。 */
  messageFailed(input: {
    runId: string;
    messageId?: string;
    reason?: string;
  }): RecordRunEventInput | undefined {
    if (!input.messageId) return undefined;
    return {
      runId: input.runId,
      eventKey: `message:${input.messageId}:failed`,
      type: "message.failed",
      origin: "platform",
      targetType: "message",
      targetId: input.messageId,
      chainId: input.messageId,
      refs: { messageId: input.messageId },
      summary: input.reason,
      data: compactData({ reason: input.reason }),
    };
  }

  /** 构建 permission.requested 事件：run 进入 requires_action,等待用户审批/回答。 */
  permissionRequested(input: { runId: string }): RecordRunEventInput {
    return {
      runId: input.runId,
      type: "permission.requested",
      origin: "worker",
      targetType: "permission_request",
      targetId: input.runId,
      chainId: input.runId,
      summary: "Waiting for user response",
    };
  }

  /** 构建 permission.resolved 事件：用户提交审批/回答,平台已接收。 */
  permissionResolved(input: { runId: string }): RecordRunEventInput {
    return {
      runId: input.runId,
      type: "permission.resolved",
      origin: "platform",
      targetType: "permission_request",
      targetId: input.runId,
      chainId: input.runId,
      summary: "User responded",
    };
  }

  /** 构建 worker.status_changed 事件：记录 worker 侧状态变化(如心跳超时被 fence)。 */
  workerStatusChanged(input: {
    runId: string;
    status: string;
    reason?: string;
  }): RecordRunEventInput {
    return {
      runId: input.runId,
      type: "worker.status_changed",
      origin: "platform",
      targetType: "worker",
      chainId: input.runId,
      summary: input.reason,
      data: compactData({ status: input.status, reason: input.reason }),
    };
  }

  /** 构建 tool.started 事件：工具调用开始；缺少 toolCallId 时不产生事件。 */
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

  /** 构建 tool.completed 事件：工具调用成功完成；缺少 toolCallId 时不产生事件。 */
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

  /** 构建 tool.failed 事件：工具调用失败；缺少 toolCallId 时不产生事件。 */
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

  /** 构建 system.issue 事件：记录平台/agent/worker 侧的诊断问题。 */
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

  /** 将 worker 上行消息的 seq 跳号归一化为 system.issue 事件（worker_seq_gap）。 */
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

  /** 将 worker 上报的 run 状态 payload 归一化为 run.status_changed 事件。 */
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

  /** 将一条 AG-UI 事件归一化为 0..N 条结构化 run event。 */
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

  /** 将 SDK 原始事件归一化为 system.issue 事件；仅错误类事件产生结果,否则返回 undefined。 */
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

  /** 将命令 trace payload 归一化为 command.handled 或 command.failed 事件。 */
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

  /** 将命令 result payload 归一化为 command.result 事件。 */
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
}

/** 分页响应信封:由根 Service 收口(数据层只回 list/total)。 */
function pageEnvelope(params: { take: number; skip: number }): {
  pageNo: number;
  pageSize: number;
} {
  return { pageNo: params.skip / params.take + 1, pageSize: params.take };
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
