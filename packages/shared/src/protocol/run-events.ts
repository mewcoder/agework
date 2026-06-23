export type RunEventOrigin = "platform" | "agent" | "worker";

export type CoreRunEventType =
  | "run.created"
  | "run.status_changed"
  | "runtime.status_changed"
  | "worker.status_changed"
  | "message.accepted"
  | "message.started"
  | "message.completed"
  | "message.failed"
  | "message.write_failed"
  | "tool.started"
  | "tool.completed"
  | "tool.failed"
  | "permission.requested"
  | "permission.resolved"
  | "control.sent"
  | "control.handled"
  | "control.failed"
  | "system.issue";

export type RunEventType = CoreRunEventType | (string & {});

export type RunEventTargetType =
  | "run"
  | "message"
  | "tool_call"
  | "command"
  | "permission_request"
  | "session"
  | "runtime"
  | "worker";

export type RunEventRefs = Partial<{
  messageId: string;
  toolCallId: string;
  parentMessageId: string;
  parentToolCallId: string;
  commandId: string;
  permissionRequestId: string;
  sessionId: string;
  conversationId: string;
  userId: string;
  agentId: string;
  workerId: string;
  providerRequestId: string;
}>;

export type RunEventDataValue =
  | string
  | number
  | boolean
  | null
  | RunEventDataValue[]
  | { [key: string]: RunEventDataValue };

export type RunEventData = Record<string, RunEventDataValue>;

export type RunEventRecord = {
  id: string;
  runId: string;
  runSeq: number;
  eventKey: string | null;
  type: RunEventType;
  origin: RunEventOrigin;
  targetType: RunEventTargetType | null;
  targetId: string | null;
  chainId: string | null;
  refs: RunEventRefs | null;
  summary: string | null;
  data: RunEventData | null;
  createdAt: string;
};

export type RecordRunEventInput = {
  runId: string;
  eventKey?: string;
  type: RunEventType;
  origin: RunEventOrigin;
  targetType?: RunEventTargetType;
  targetId?: string;
  chainId?: string;
  refs?: RunEventRefs;
  summary?: string;
  data?: RunEventData;
};

export type RunFact = RecordRunEventInput;
