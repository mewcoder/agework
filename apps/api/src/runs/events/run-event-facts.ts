import type {
  RecordRunEventInput,
  RunEventData,
  RunEventOrigin,
  RunEventRefs,
  RunEventTargetType,
} from "@agework/shared/protocol";
import type { RunStatusPayload } from "@agework/shared/protocol";

type RunFactBase = {
  runId: string;
  eventKey?: string;
  targetType?: RunEventTargetType;
  targetId?: string;
  chainId?: string;
  refs?: RunEventRefs;
  summary?: string;
  data?: RunEventData;
};

export const RunEventFacts = {
  runCreated(input: {
    runId: string;
    conversationId: string;
    workspaceId?: string;
    agentType: string;
    runtimeType: string;
    /**
     * 隔离粒度，仅 sandbox run 有值（user/workspace）。
     * local run 无容器隔离语义，此字段为 undefined——不要按 isolationScope 过滤/分组
     * RunEvent；admin 列表/详情里的 isolationScope 维度走 RuntimeTarget DB 列，不依赖此处。
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
  },

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
  },

  runtimeStatusChanged(input: RunFactBase & {
    status: string;
    runtimeType?: string;
    runtimeInstanceId?: string;
    /** 见 runCreated.isolationScope：local run 为 undefined。 */
    isolationScope?: string;
    /** 沙箱引擎类型，仅 sandbox run 有值；local run 为 undefined。 */
    sandboxEngineType?: string;
    error?: string;
  }): RecordRunEventInput {
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
  },

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
  },

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
  },

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
  },

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
  },

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
  },

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
  },

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
  },

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
  },

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
  },

  systemIssue(input: RunFactBase & {
    code: string;
    message?: string;
    origin?: RunEventOrigin;
    severity?: "warn" | "error";
  }): RecordRunEventInput {
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
  },
};

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
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (child !== undefined) output[key] = jsonSafe(child);
    }
    return output;
  }
  return String(value);
}
