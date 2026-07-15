import type {
  RunConfig,
  WorkerRegisterRequest,
  WorkerRegisterResponse,
} from "./channel.js";
import type {
  HostTunnelAllRpcRequest,
  HostTunnelClientMessage,
  HostTunnelHostNotification,
  HostTunnelHostRpcResponse,
  HostTunnelRegisteredMessage,
  HostUpstreamEnvelope,
  HostUpstreamNotification,
} from "./host-tunnel.js";
import {
  isRpcNotification,
  isRpcRequest,
  isRpcResponse,
  isWorkerCommandRpcRequest,
  type WorkerCommandRpcRequest,
} from "./rpc.js";

/** Host ↔ Server / Host ↔ Worker 网络边界的运行时解码器。 */

export function isHostTunnelClientMessage(
  value: unknown
): value is HostTunnelClientMessage {
  if (!isRecord(value)) return false;
  if (value.type === "heartbeat") return true;
  return (
    value.type === "register" &&
    isProtocolVersion(value.protocolVersion) &&
    isNonEmptyString(value.processInstanceId) &&
    isRuntimeCapabilities(value.capabilities) &&
    optionalString(value.version) &&
    optionalRecord(value.envConfig)
  );
}

export function isHostTunnelRegisteredMessage(
  value: unknown
): value is HostTunnelRegisteredMessage {
  return (
    isRecord(value) &&
    value.type === "registered" &&
    isNonEmptyString(value.runtimeHostId) &&
    isPositiveNumber(value.heartbeatIntervalSeconds) &&
    isProtocolVersion(value.protocolVersion) &&
    optionalPositiveInteger(value.epoch)
  );
}

export function isHostTunnelHostRpcRequest(
  value: unknown
): value is HostTunnelAllRpcRequest {
  if (!isRpcRequest(value) || !isRecord(value.params)) return false;
  const params = value.params;
  switch (value.method) {
    case "host.submitRun":
      return isSubmitRunInput(params);
    case "host.command":
      return isRuntimeHostCommandInput(params);
    case "host.releaseOwner":
      return isRuntimeHostId(params) && isOwnerKey(params.owner);
    case "host.detectEnv":
      return isRuntimeHostId(params);
    case "host.listDirectory":
      return isRuntimeHostId(params) && optionalString(params.path);
    case "host.createDirectory":
      return isRuntimeHostId(params) && isString(params.path);
    case "host.listFiles":
    case "host.readFile":
    case "host.readFileDiff":
      return (
        isRuntimeHostId(params) &&
        isString(params.rootPath) &&
        isString(params.path)
      );
    case "host.searchFiles":
    case "host.listChangedFiles":
      return isRuntimeHostId(params) && isString(params.rootPath);
    case "host.listWorkers":
      return true;
    case "host.stopWorker":
      return isRuntimeHostId(params) && isNonEmptyString(params.key);
    case "host.installCli":
      return isRuntimeHostId(params) && isNonEmptyString(params.agentType);
    default:
      return false;
  }
}

export function isHostTunnelClientNotification(
  value: unknown
): value is Extract<HostTunnelHostNotification, { method: "host.upstream" }> {
  return (
    isRpcNotification(value) &&
    value.method === "host.upstream" &&
    isHostUpstreamEnvelope(value.params)
  );
}

export function isHostTunnelServerNotification(
  value: unknown
): value is Exclude<HostTunnelHostNotification, { method: "host.upstream" }> {
  if (!isRpcNotification(value)) return false;
  switch (value.method) {
    case "host.upstreamAck":
      return isRecord(value.params) && isPositiveInteger(value.params.seq);
    case "host.releaseRun":
      return (
        isRecord(value.params) &&
        isRuntimeHostId(value.params) &&
        isNonEmptyString(value.params.runId)
      );
    default:
      return false;
  }
}

export function isHostTunnelHostRpcResponse(
  value: unknown
): value is HostTunnelHostRpcResponse {
  return isRpcResponse(value);
}

export function isHostUpstreamEnvelope(
  value: unknown
): value is HostUpstreamEnvelope {
  return (
    isRecord(value) &&
    isPositiveInteger(value.seq) &&
    optionalPositiveInteger(value.epoch) &&
    isHostUpstreamNotification(value.notification)
  );
}

export function isWorkerRegisterRequest(
  value: unknown
): value is WorkerRegisterRequest {
  return (
    isRecord(value) &&
    typeof value.startToken === "string" &&
    optionalFiniteNumber(value.pid) &&
    isProtocolVersion(value.protocolVersion) &&
    optionalString(value.version)
  );
}

export function isWorkerRegisterResponse(
  value: unknown
): value is WorkerRegisterResponse {
  return (
    isRecord(value) &&
    value.ok === true &&
    isProtocolVersion(value.protocolVersion)
  );
}

export type WorkerCommandPollResponse = {
  messages: WorkerCommandRpcRequest[];
  queueEpoch?: number;
};

export function isWorkerCommandPollResponse(
  value: unknown
): value is WorkerCommandPollResponse {
  return (
    isRecord(value) &&
    Array.isArray(value.messages) &&
    value.messages.every(isWorkerCommandRpcRequest) &&
    optionalNonNegativeInteger(value.queueEpoch)
  );
}

export type WorkerRunConfigResponse = { config: RunConfig };

export function isWorkerRunConfigResponse(
  value: unknown
): value is WorkerRunConfigResponse {
  return isRecord(value) && isRunConfig(value.config);
}

export function isWireMessageType<Type extends string>(
  value: unknown,
  type: Type
): value is Record<string, unknown> & { type: Type } {
  return isRecord(value) && value.type === type;
}

function isHostUpstreamNotification(
  value: unknown
): value is HostUpstreamNotification {
  if (!isRecord(value) || !isNonEmptyString(value.runId)) return false;
  switch (value.kind) {
    case "emit":
      return isRecord(value.message);
    case "runFailed":
      return typeof value.error === "string";
    case "runCancelled":
      return true;
    case "workerLost":
      return typeof value.reason === "string";
    default:
      return false;
  }
}

function isSubmitRunInput(value: Record<string, unknown>): boolean {
  if (
    !isNonEmptyString(value.runId) ||
    !isNonEmptyString(value.conversationId) ||
    !isRecord(value.placement) ||
    !isRecord(value.agentProviderConfig) ||
    !("input" in value)
  ) {
    return false;
  }
  const placement = value.placement;
  return (
    isOwnerKey(placement.owner) &&
    isNonEmptyString(placement.runtimeType) &&
    isNonEmptyString(placement.runtimeHostId) &&
    isNonEmptyString(placement.workspaceId) &&
    isNonEmptyString(placement.userId) &&
    isNonEmptyString(placement.username) &&
    isString(placement.workspacePath)
  );
}

function isRuntimeHostCommandInput(value: Record<string, unknown>): boolean {
  if (!isRuntimeHostId(value) || !isRecord(value.payload)) return false;
  const payload = value.payload;
  if (
    !isNonEmptyString(payload.type) ||
    !isNonEmptyString(payload.commandId) ||
    !isNonEmptyString(payload.runId)
  ) {
    return false;
  }
  switch (payload.type) {
    case "user_message":
    case "interrupt":
      return true;
    case "cancel":
      return isNonEmptyString(payload.conversationId);
    case "approval_resolved":
      return (
        isNonEmptyString(payload.conversationId) &&
        "payload" in payload &&
        optionalString(payload.resumeRunId)
      );
    default:
      return false;
  }
}

function isRunConfig(value: unknown): value is RunConfig {
  if (!isRecord(value) || !isRecord(value.agentProviderConfig)) return false;
  const provider = value.agentProviderConfig;
  const providerIsValid =
    isNonEmptyString(provider.agentType) &&
    (provider.source === "system" ||
      (provider.source === "custom" &&
        isString(provider.baseUrl) &&
        isString(provider.apiKey) &&
        isNonEmptyString(provider.model) &&
        optionalStringRecord(provider.extraConfig)));
  return (
    isNonEmptyString(value.runId) &&
    isNonEmptyString(value.conversationId) &&
    isNonEmptyString(value.workspaceId) &&
    isString(value.runtimePath) &&
    isStringRecord(value.env) &&
    "input" in value &&
    providerIsValid
  );
}

function isRuntimeCapabilities(value: unknown): boolean {
  if (!isRecord(value) || Object.keys(value).length === 0) return false;
  return Object.values(value).every(
    (status) =>
      isRecord(status) &&
      typeof status.available === "boolean" &&
      Array.isArray(status.scopes) &&
      status.scopes.every(
        (scope) => scope === "workspace" || scope === "user"
      ) &&
      optionalString(status.reason) &&
      optionalRecord(status.cli)
  );
}

function isRuntimeHostId(value: Record<string, unknown>): boolean {
  return isNonEmptyString(value.runtimeHostId);
}

function isOwnerKey(value: unknown): boolean {
  return typeof value === "string" && /^(workspace|user):.+/.test(value);
}

function isProtocolVersion(value: unknown): value is number {
  return isPositiveInteger(value);
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && typeof value === "number" && value > 0;
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function optionalPositiveInteger(value: unknown): boolean {
  return value === undefined || isPositiveInteger(value);
}

function optionalNonNegativeInteger(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === "number" && Number.isInteger(value) && value >= 0)
  );
}

function optionalFiniteNumber(value: unknown): boolean {
  return (
    value === undefined || (typeof value === "number" && Number.isFinite(value))
  );
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function optionalRecord(value: unknown): boolean {
  return value === undefined || isRecord(value);
}

function optionalStringRecord(value: unknown): boolean {
  return value === undefined || isStringRecord(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every(isString);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
