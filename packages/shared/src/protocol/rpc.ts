import type { RunChannelMessage } from "./run-channel-message";
import type {
  AGUIEvent,
  ArtifactRefPayload,
  CommandPayload,
  CommandResultPayload,
  CommandTracePayload,
  RunConfig,
  RunStatusPayload,
  UpstreamMessage,
} from "./channel";
import type { AgentEventTracePayload } from "./trace";

export const JSON_RPC_VERSION = "2.0" as const;

export type RpcId = string | number;

export type RpcMeta = {
  runId?: string;
  seq?: number;
  ts?: string;
};

export type RpcRequest<
  Method extends string = string,
  Params = unknown,
> = {
  jsonrpc: typeof JSON_RPC_VERSION;
  id: RpcId;
  method: Method;
  params: Params;
  meta?: RpcMeta;
};

export type RpcNotification<
  Method extends string = string,
  Params = unknown,
> = {
  jsonrpc: typeof JSON_RPC_VERSION;
  method: Method;
  params: Params;
  meta?: RpcMeta;
};

export type RpcSuccessResponse<Result = unknown> = {
  jsonrpc: typeof JSON_RPC_VERSION;
  id: RpcId;
  result: Result;
  meta?: RpcMeta;
};

export type RpcError = {
  code: number;
  message: string;
  data?: unknown;
};

export type RpcErrorResponse = {
  jsonrpc: typeof JSON_RPC_VERSION;
  id: RpcId | null;
  error: RpcError;
  meta?: RpcMeta;
};

export type RpcResponse<Result = unknown> =
  | RpcSuccessResponse<Result>
  | RpcErrorResponse;

export type RpcMessage =
  | RpcRequest
  | RpcNotification
  | RpcResponse;

export type RpcBatch = RpcMessage[];

export type WorkerCommandMethod =
  | "run.start"
  | "run.cancel"
  | "run.interrupt"
  | "control.resolve";

export type RunStartParams = {
  runId: string;
};

export type RunCancelParams = {
  runId: string;
  conversationId: string;
};

export type RunInterruptParams = {
  runId: string;
};

export type ControlResolveParams = {
  runId?: string;
  conversationId: string;
  answers: Record<string, string | string[]>;
};

export type WorkerCommandRpcRequest =
  | RpcRequest<"run.start", RunStartParams>
  | RpcRequest<"run.cancel", RunCancelParams>
  | RpcRequest<"run.interrupt", RunInterruptParams>
  | RpcRequest<"control.resolve", ControlResolveParams>;

export type RunConfigRpcParams = {
  runId: string;
  config: RunConfig;
};

export type RunConfigRpcNotification = RpcNotification<
  "run.config",
  RunConfigRpcParams
>;

export type WorkerEventMethod =
  | "run.status"
  | "run.aguiEvent"
  | "trace.sdkRaw"
  | "artifact.ref"
  | "command.trace";

export type RunStatusRpcParams = {
  runId: string;
  status: RunStatusPayload;
};

export type RunAguiEventRpcParams = {
  runId: string;
  event: AGUIEvent;
};

export type TraceSdkRawRpcParams = {
  runId: string;
  trace: AgentEventTracePayload;
};

export type ArtifactRefRpcParams = {
  runId: string;
  artifact: ArtifactRefPayload;
};

export type CommandTraceRpcParams = {
  runId: string;
  trace: CommandTracePayload;
};

export type WorkerEventRpcNotification =
  | RpcNotification<"run.status", RunStatusRpcParams>
  | RpcNotification<"run.aguiEvent", RunAguiEventRpcParams>
  | RpcNotification<"trace.sdkRaw", TraceSdkRawRpcParams>
  | RpcNotification<"artifact.ref", ArtifactRefRpcParams>
  | RpcNotification<"command.trace", CommandTraceRpcParams>;

export type WorkerCommandResult = {
  ok: boolean;
  runId?: string;
  commandType?: CommandPayload["type"];
  error?: string;
};

export function rpcSuccess<Result>(
  id: RpcId,
  result: Result,
  meta?: RpcMeta
): RpcSuccessResponse<Result> {
  return { jsonrpc: JSON_RPC_VERSION, id, result, ...(meta ? { meta } : {}) };
}

export function rpcError(
  id: RpcId | null,
  error: RpcError,
  meta?: RpcMeta
): RpcErrorResponse {
  return { jsonrpc: JSON_RPC_VERSION, id, error, ...(meta ? { meta } : {}) };
}

export function commandMessageToRpcRequest(
  message: RunChannelMessage<CommandPayload>
): WorkerCommandRpcRequest {
  const meta = messageMeta(message);
  const command = message.payload;
  switch (command.type) {
    case "user_message":
      return {
        jsonrpc: JSON_RPC_VERSION,
        id: command.commandId,
        method: "run.start",
        params: { runId: command.runId },
        meta,
      };
    case "cancel":
      return {
        jsonrpc: JSON_RPC_VERSION,
        id: command.commandId,
        method: "run.cancel",
        params: {
          runId: command.runId,
          conversationId: command.conversationId,
        },
        meta,
      };
    case "interrupt":
      return {
        jsonrpc: JSON_RPC_VERSION,
        id: command.commandId,
        method: "run.interrupt",
        params: { runId: command.runId ?? message.runId },
        meta,
      };
    case "approval_resolved":
      return {
        jsonrpc: JSON_RPC_VERSION,
        id: command.commandId,
        method: "control.resolve",
        params: {
          runId: message.runId || undefined,
          conversationId: command.conversationId,
          answers: command.answers,
        },
        meta,
      };
  }
}

export function rpcRequestToCommandMessage(
  request: WorkerCommandRpcRequest
): RunChannelMessage<CommandPayload> {
  const runId = commandRunId(request);
  return {
    runId,
    seq: request.meta?.seq ?? 0,
    type: "command",
    payload: rpcRequestToCommandPayload(request),
    ts: request.meta?.ts ?? new Date().toISOString(),
  };
}

export function rpcRequestToCommandPayload(
  request: WorkerCommandRpcRequest
): CommandPayload {
  const commandId = String(request.id);
  switch (request.method) {
    case "run.start":
      return {
        type: "user_message",
        commandId,
        runId: request.params.runId,
      };
    case "run.cancel":
      return {
        type: "cancel",
        commandId,
        runId: request.params.runId,
        conversationId: request.params.conversationId,
      };
    case "run.interrupt":
      return {
        type: "interrupt",
        commandId,
        ...(request.params.runId ? { runId: request.params.runId } : {}),
      };
    case "control.resolve":
      return {
        type: "approval_resolved",
        commandId,
        conversationId: request.params.conversationId,
        answers: request.params.answers,
      };
  }
}

export function runConfigMessageToRpcNotification(
  message: RunChannelMessage<RunConfig>
): RunConfigRpcNotification {
  return {
    jsonrpc: JSON_RPC_VERSION,
    method: "run.config",
    params: {
      runId: message.runId,
      config: message.payload,
    },
    meta: messageMeta(message),
  };
}

export function rpcNotificationToRunConfigMessage(
  notification: RunConfigRpcNotification
): RunChannelMessage<RunConfig> {
  return {
    runId: notification.params.runId,
    seq: notification.meta?.seq ?? 0,
    type: "run.config",
    payload: notification.params.config,
    ts: notification.meta?.ts ?? new Date().toISOString(),
  };
}

export function commandResultToRpcResponse(input: {
  commandId: string;
  ok: boolean;
  runId?: string;
  commandType?: CommandPayload["type"];
  error?: string;
  meta?: RpcMeta;
}): RpcResponse<WorkerCommandResult> {
  if (input.ok) {
    return rpcSuccess(
      input.commandId,
      {
        ok: true,
        runId: input.runId,
        commandType: input.commandType,
      },
      input.meta
    );
  }
  return rpcError(
    input.commandId,
    {
      code: -32_000,
      message: input.error ?? "Command failed",
      data: {
        ok: false,
        runId: input.runId,
        commandType: input.commandType,
        error: input.error,
      } satisfies WorkerCommandResult,
    },
    input.meta
  );
}

export function commandResultMessageToRpcResponse(
  message: RunChannelMessage<CommandResultPayload>
): RpcResponse<WorkerCommandResult> {
  const payload = message.payload;
  return commandResultToRpcResponse({
    commandId: payload.commandId,
    ok: payload.status === "ok",
    runId: message.runId,
    commandType: payload.commandType,
    error: payload.error,
    meta: messageMeta(message),
  });
}

export function rpcResponseToCommandResultMessage(
  response: RpcResponse<WorkerCommandResult>,
  fallback?: { runId?: string; seq?: number; ts?: string }
): RunChannelMessage<CommandResultPayload> | undefined {
  if (response.id === null) return undefined;
  const result = commandResultFromRpcResponse(response);
  const runId = result.runId ?? response.meta?.runId ?? fallback?.runId;
  if (!runId || !result.commandType) return undefined;
  return {
    runId,
    seq: response.meta?.seq ?? fallback?.seq ?? 0,
    type: "command.result",
    payload: {
      commandId: String(response.id),
      commandType: result.commandType,
      status: result.ok ? "ok" : "error",
      ...(result.error ? { error: result.error } : {}),
    },
    ts: response.meta?.ts ?? fallback?.ts ?? new Date().toISOString(),
  };
}

export function upstreamMessageToRpcNotification(
  message: UpstreamMessage
): WorkerEventRpcNotification {
  const meta = messageMeta(message);
  switch (message.type) {
    case "run.status":
      return {
        jsonrpc: JSON_RPC_VERSION,
        method: "run.status",
        params: { runId: message.runId, status: message.payload as RunStatusPayload },
        meta,
      };
    case "agui.event":
      return {
        jsonrpc: JSON_RPC_VERSION,
        method: "run.aguiEvent",
        params: { runId: message.runId, event: message.payload as AGUIEvent },
        meta,
      };
    case "sdk.raw":
      return {
        jsonrpc: JSON_RPC_VERSION,
        method: "trace.sdkRaw",
        params: {
          runId: message.runId,
          trace: message.payload as AgentEventTracePayload,
        },
        meta,
      };
    case "artifact.ref":
      return {
        jsonrpc: JSON_RPC_VERSION,
        method: "artifact.ref",
        params: {
          runId: message.runId,
          artifact: message.payload as ArtifactRefPayload,
        },
        meta,
      };
    case "command.trace":
      return {
        jsonrpc: JSON_RPC_VERSION,
        method: "command.trace",
        params: {
          runId: message.runId,
          trace: message.payload as CommandTracePayload,
        },
        meta,
      };
    default:
      throw new Error(`Unsupported upstream message type: ${message.type}`);
  }
}

export function rpcNotificationToUpstreamMessage(
  notification: WorkerEventRpcNotification
): UpstreamMessage {
  const base = {
    runId: notification.params.runId,
    seq: notification.meta?.seq ?? 0,
    ts: notification.meta?.ts ?? new Date().toISOString(),
  };
  switch (notification.method) {
    case "run.status":
      return {
        ...base,
        type: "run.status",
        payload: notification.params.status,
      };
    case "run.aguiEvent":
      return {
        ...base,
        type: "agui.event",
        payload: notification.params.event,
      };
    case "trace.sdkRaw":
      return {
        ...base,
        type: "sdk.raw",
        payload: notification.params.trace,
      };
    case "artifact.ref":
      return {
        ...base,
        type: "artifact.ref",
        payload: notification.params.artifact,
      };
    case "command.trace":
      return {
        ...base,
        type: "command.trace",
        payload: notification.params.trace,
      };
  }
}

export function isRpcMessage(value: unknown): value is RpcMessage {
  return (
    isRecord(value) &&
    value.jsonrpc === JSON_RPC_VERSION &&
    (isRpcRequest(value) || isRpcNotification(value) || isRpcResponse(value))
  );
}

export function isRpcRequest(value: unknown): value is RpcRequest {
  return (
    isRecord(value) &&
    value.jsonrpc === JSON_RPC_VERSION &&
    typeof value.method === "string" &&
    isRpcId(value.id) &&
    "params" in value &&
    !("result" in value) &&
    !("error" in value) &&
    hasValidMeta(value)
  );
}

export function isRpcNotification(value: unknown): value is RpcNotification {
  return (
    isRecord(value) &&
    value.jsonrpc === JSON_RPC_VERSION &&
    typeof value.method === "string" &&
    !("id" in value) &&
    "params" in value &&
    !("result" in value) &&
    !("error" in value) &&
    hasValidMeta(value)
  );
}

export function isRpcResponse(value: unknown): value is RpcResponse {
  if (
    !isRecord(value) ||
    value.jsonrpc !== JSON_RPC_VERSION ||
    !("id" in value) ||
    !isRpcResponseId(value.id) ||
    typeof value.method !== "undefined" ||
    !hasValidMeta(value)
  ) {
    return false;
  }
  const hasResult = "result" in value;
  const hasError = "error" in value;
  if (hasResult === hasError) return false;
  if (hasError) return isRpcErrorObject(value.error);
  return true;
}

export function isWorkerCommandResultRpcResponse(
  value: unknown
): value is RpcResponse<WorkerCommandResult> {
  if (!isRpcResponse(value) || value.id === null) return false;
  if ("result" in value) {
    return isWorkerCommandSuccessResult(value.result);
  }
  return isWorkerCommandErrorResult(value.error.data);
}

export function isRunConfigRpcNotification(
  value: unknown
): value is RunConfigRpcNotification {
  return (
    isRpcNotification(value) &&
    value.method === "run.config" &&
    isRunConfigParams(value.params)
  );
}

export function isWorkerCommandRpcRequest(
  value: unknown
): value is WorkerCommandRpcRequest {
  if (!isRpcRequest(value)) return false;
  switch (value.method) {
    case "run.start":
      return isRunStartParams(value.params);
    case "run.cancel":
      return isRunCancelParams(value.params);
    case "run.interrupt":
      return isRunInterruptParams(value.params);
    case "control.resolve":
      return isControlResolveParams(value.params);
    default:
      return false;
  }
}

export function isWorkerEventRpcNotification(
  value: unknown
): value is WorkerEventRpcNotification {
  if (!isRpcNotification(value)) return false;
  switch (value.method) {
    case "run.status":
      return isRunStatusParams(value.params);
    case "run.aguiEvent":
      return isRunAguiEventParams(value.params);
    case "trace.sdkRaw":
      return isTraceSdkRawParams(value.params);
    case "artifact.ref":
      return isArtifactRefParams(value.params);
    case "command.trace":
      return isCommandTraceParams(value.params);
    default:
      return false;
  }
}

function isRpcId(value: unknown): value is RpcId {
  return (
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function isRpcResponseId(value: unknown): value is RpcId | null {
  return value === null || isRpcId(value);
}

function hasValidMeta(value: Record<string, unknown>): boolean {
  return !("meta" in value) || isRpcMeta(value.meta);
}

function isRpcMeta(value: unknown): value is RpcMeta {
  return (
    isRecord(value) &&
    optionalString(value.runId) &&
    optionalNumber(value.seq) &&
    optionalString(value.ts)
  );
}

function isRpcErrorObject(value: unknown): value is RpcError {
  return (
    isRecord(value) &&
    typeof value.code === "number" &&
    Number.isFinite(value.code) &&
    typeof value.message === "string"
  );
}

function isRunStartParams(value: unknown): value is RunStartParams {
  return isRecord(value) && isNonEmptyString(value.runId);
}

function isRunCancelParams(value: unknown): value is RunCancelParams {
  return (
    isRecord(value) &&
    isNonEmptyString(value.runId) &&
    isNonEmptyString(value.conversationId)
  );
}

function isRunInterruptParams(value: unknown): value is RunInterruptParams {
  return isRecord(value) && isNonEmptyString(value.runId);
}

function isControlResolveParams(
  value: unknown
): value is ControlResolveParams {
  return (
    isRecord(value) &&
    optionalString(value.runId) &&
    isNonEmptyString(value.conversationId) &&
    isAnswerMap(value.answers)
  );
}

function isRunConfigParams(value: unknown): value is RunConfigRpcParams {
  return (
    isRecord(value) &&
    isNonEmptyString(value.runId) &&
    isRunConfig(value.config)
  );
}

function isRunStatusParams(value: unknown): value is RunStatusRpcParams {
  return (
    isRecord(value) &&
    isNonEmptyString(value.runId) &&
    isRunStatusPayload(value.status)
  );
}

function isRunAguiEventParams(value: unknown): value is RunAguiEventRpcParams {
  return (
    isRecord(value) &&
    isNonEmptyString(value.runId) &&
    isAguiEvent(value.event)
  );
}

function isTraceSdkRawParams(value: unknown): value is TraceSdkRawRpcParams {
  return (
    isRecord(value) &&
    isNonEmptyString(value.runId) &&
    isAgentEventTracePayload(value.trace)
  );
}

function isArtifactRefParams(value: unknown): value is ArtifactRefRpcParams {
  return (
    isRecord(value) &&
    isNonEmptyString(value.runId) &&
    isArtifactRefPayload(value.artifact)
  );
}

function isCommandTraceParams(value: unknown): value is CommandTraceRpcParams {
  return (
    isRecord(value) &&
    isNonEmptyString(value.runId) &&
    isCommandTracePayload(value.trace)
  );
}

function isWorkerCommandSuccessResult(
  value: unknown
): value is WorkerCommandResult {
  return (
    isRecord(value) &&
    value.ok === true &&
    isCommandType(value.commandType) &&
    optionalString(value.runId) &&
    optionalString(value.error)
  );
}

function isWorkerCommandErrorResult(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.ok === false &&
    isCommandType(value.commandType) &&
    optionalString(value.runId) &&
    optionalString(value.error)
  );
}

function isRunConfig(value: unknown): value is RunConfig {
  return (
    isRecord(value) &&
    isNonEmptyString(value.runId) &&
    isNonEmptyString(value.conversationId) &&
    isNonEmptyString(value.workspaceId) &&
    isNonEmptyString(value.runtimePath) &&
    isStringRecord(value.env) &&
    "input" in value &&
    isAgentProviderConfig(value.agentProviderConfig)
  );
}

function isAgentProviderConfig(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!isNonEmptyString(value.agentType)) return false;
  if (value.source === "system") return true;
  return (
    value.source === "custom" &&
    isNonEmptyString(value.baseUrl) &&
    isNonEmptyString(value.apiKey) &&
    isNonEmptyString(value.model) &&
    (!("extraConfig" in value) || isStringRecord(value.extraConfig))
  );
}

function isRunStatusPayload(value: unknown): value is RunStatusPayload {
  return (
    isRecord(value) &&
    isRunStatus(value.status) &&
    optionalString(value.phase) &&
    optionalString(value.error) &&
    (!("pendingAction" in value) ||
      value.pendingAction === "question" ||
      value.pendingAction === null)
  );
}

function isRunStatus(value: unknown): value is RunStatusPayload["status"] {
  return (
    value === "queued" ||
    value === "preparing" ||
    value === "running" ||
    value === "requires_action" ||
    value === "cancelling" ||
    value === "finished" ||
    value === "error" ||
    value === "cancelled"
  );
}

function isAguiEvent(value: unknown): value is AGUIEvent {
  return isRecord(value) && isNonEmptyString(value.type);
}

function isAgentEventTracePayload(
  value: unknown
): value is AgentEventTracePayload {
  return isRecord(value) && isNonEmptyString(value.name);
}

function isArtifactRefPayload(value: unknown): value is ArtifactRefPayload {
  return (
    isRecord(value) &&
    isNonEmptyString(value.artifactId) &&
    isNonEmptyString(value.kind) &&
    isNonEmptyString(value.uri)
  );
}

function isCommandTracePayload(value: unknown): value is CommandTracePayload {
  return (
    isRecord(value) &&
    (value.phase === "received" ||
      value.phase === "handled" ||
      value.phase === "failed") &&
    isNonEmptyString(value.commandId) &&
    isNonEmptyString(value.commandType) &&
    optionalString(value.error)
  );
}

function isAnswerMap(
  value: unknown
): value is Record<string, string | string[]> {
  return (
    isRecord(value) &&
    Object.values(value).every(
      (answer) =>
        typeof answer === "string" ||
        (Array.isArray(answer) &&
          answer.every((item) => typeof item === "string"))
    )
  );
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) &&
    Object.values(value).every((item) => typeof item === "string")
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function optionalNumber(value: unknown): boolean {
  return value === undefined || (typeof value === "number" && Number.isFinite(value));
}

function commandResultFromRpcResponse(
  response: RpcResponse<WorkerCommandResult>
): WorkerCommandResult {
  if ("result" in response) return response.result;
  const data = response.error.data;
  if (isRecord(data)) {
    return {
      ok: data.ok === true,
      runId: typeof data.runId === "string" ? data.runId : undefined,
      commandType: isCommandType(data.commandType)
        ? data.commandType
        : undefined,
      error:
        typeof data.error === "string" ? data.error : response.error.message,
    };
  }
  return { ok: false, error: response.error.message };
}

function isCommandType(value: unknown): value is CommandPayload["type"] {
  return (
    value === "cancel" ||
    value === "interrupt" ||
    value === "approval_resolved" ||
    value === "user_message"
  );
}

function commandRunId(request: WorkerCommandRpcRequest): string {
  if ("runId" in request.params && typeof request.params.runId === "string") {
    return request.params.runId;
  }
  return request.meta?.runId ?? "";
}

function messageMeta(message: RunChannelMessage<unknown>): RpcMeta {
  return {
    runId: message.runId,
    seq: message.seq,
    ts: message.ts,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
