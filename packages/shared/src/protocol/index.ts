import type { RunChannelMessage } from "./run-channel-message";
import type { CommandPayload, WorkerScope } from "./channel";
import type { RuntimeCapabilities } from "./runtime-capabilities";

export type { RunChannelMessage } from "./run-channel-message";

/** 构造下一个 command message 并递增 seq 计数器。
 *  @param seqKey - runId（Local 模式）或 workerId（Docker 模式），用于 seq 计数器分区。 */
export function nextCommandMessage(
  commandSeqs: Map<string, number>,
  seqKey: string,
  runId: string,
  payload: CommandPayload
): RunChannelMessage<CommandPayload> {
  const seq = (commandSeqs.get(seqKey) ?? 0) + 1;
  commandSeqs.set(seqKey, seq);
  return {
    runId,
    seq,
    type: "command",
    payload: payload,
    ts: new Date().toISOString(),
  };
}

export type {
  AgentEventTraceConfig,
  AgentEventTracePayload,
  AgentTraceEvent,
  AgentTraceSink,
} from "./trace";
export type {
  CoreRunEventType,
  RecordRunEventInput,
  RunEventData,
  RunEventDataValue,
  RunEventOrigin,
  RunEventRecord,
  RunEventRefs,
  RunEventTargetType,
  RunEventType,
  RunFact,
} from "./run-events";
/**
 * worker 调用 commands/runConfig/events 三个端点时携带的鉴权 header 名字。
 * server 端 guard 与 worker 端 HTTP client 共用同一份常量，避免两侧各自手写
 * 字符串导致打错。register 端点本身不用这两个 header（走 body 里的
 * startToken，见 WorkerRegisterRequest）。
 */
export const WORKER_TOKEN_HEADER = "x-agework-worker-token";
export const WORKER_ID_HEADER = "x-agework-worker-id";

export type {
  AGUIEvent,
  AgentType,
  RunStatus,
  RunStatusPayload,
  RunUsage,
  AgentContextUsage,
  ArtifactRefPayload,
  RunConfig,
  SystemAgentProviderConfig,
  CustomAgentProviderConfig,
  AgentProviderConfig,
  CommandPayload,
  CommandResultPayload,
  CommandTracePayload,
  UpstreamMessage,
  UpstreamMessageInput,
  Unsubscribe,
  RunChannel,
  RunExecutionHandle,
  WorkerRegisterRequest,
  WorkerRegisterResponse,
  WorkerScope,
  RuntimeSpec,
  NativeRuntimeSpec,
  SandboxRuntimeSpec,
  SandboxPlacementInfo,
} from "./channel";
export type {
  RuntimeType,
  RunPlacement,
  SubmitRunInput,
  RuntimeHostCommandInput,
  RuntimeHostRunRef,
  RuntimeLifecycleTarget,
  ReleaseRuntimeResourcesInput,
  RuntimeHostResourceLifecycle,
  RuntimeLifecycleClaim,
  RuntimeHostResourceReconciliation,
  StopWorkerInput,
  WorkerSnapshot,
  RuntimeHostContract,
  RuntimeHostExecution,
  RuntimeHostUpstreamBinding,
  RuntimeHostResourceLifecycle as RuntimeHostOwnerLifecycle,
  RuntimeHostEnvironment,
  RuntimeHostWorkspaceData,
  RuntimeHostDiagnostics,
  RuntimeHostUpstream,
  HostCapabilityStatus,
  AgentCliStatus,
  ListDirectoryInput,
  DirectoryListing,
  CreateDirectoryInput,
  WorkspaceFileQuery,
  ReadFileInput,
  ReadFileDiffInput,
  SearchFilesInput,
  ListChangedFilesInput,
  InstallCliInput,
  InstallCliResult,
  WorkspaceFileListResponse,
  WorkspaceFileReadResponse,
  WorkspaceFileSearchResponse,
  WorkspaceChangedFilesResponse,
  WorkspaceFileDiffResponse,
} from "./runtime-host";
export type { RuntimeCapabilities } from "./runtime-capabilities";

/** 校验并规范化一机多 runtimeType 的能力矩阵。 */
export function normalizeRuntimeCapabilities(
  value: unknown
): RuntimeCapabilities {
  if (!isRecord(value)) return {};

  const capabilities: RuntimeCapabilities = {};
  for (const [runtimeType, rawStatus] of Object.entries(value)) {
    if (!isRecord(rawStatus) || typeof rawStatus.available !== "boolean") {
      continue;
    }
    capabilities[runtimeType] = {
      available: rawStatus.available,
      scopes: Array.isArray(rawStatus.scopes)
        ? normalizeScopes(rawStatus.scopes)
        : [],
      ...(typeof rawStatus.reason === "string"
        ? { reason: rawStatus.reason }
        : {}),
      ...(typeof rawStatus.displayName === "string"
        ? { displayName: rawStatus.displayName }
        : {}),
      ...(isRecord(rawStatus.cli)
        ? { cli: rawStatus.cli as RuntimeCapabilities[string]["cli"] }
        : {}),
    };
  }
  return capabilities;
}

/** 可被新 Workspace 选择的 runtimeType 列表。 */
export function availableRuntimeTypes(
  capabilities: RuntimeCapabilities | null | undefined
): string[] {
  if (!capabilities) return [];
  return Object.entries(capabilities)
    .filter(([, status]) => status.available)
    .map(([runtimeType]) => runtimeType);
}

function normalizeScopes(scopes: unknown[]): WorkerScope[] {
  return scopes.filter(
    (scope): scope is WorkerScope => scope === "workspace" || scope === "user"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ── owner/worker key 构造器已退役 ──
// scope + userId + workspaceId 是 Server 下发的业务事实,Runtime 内部派生
// ReuseIdentity 作为复用身份。公共协议不再导出 OwnerKey/WorkerKey 构造/解析函数。

export type {
  RpcBatch,
  RpcError,
  RpcErrorResponse,
  RpcId,
  RpcMessage,
  RpcMeta,
  RpcNotification,
  RpcRequest,
  RpcResponse,
  RpcSuccessResponse,
  RunConfigRpcNotification,
  WorkerCommandMethod,
  WorkerCommandResult,
  WorkerCommandRpcRequest,
  WorkerEventMethod,
  WorkerEventRpcNotification,
} from "./rpc";

export type {
  HostTunnelClientMessage,
  HostTunnelHeartbeatMessage,
  HostTunnelRegisterMessage,
  HostTunnelRegisteredMessage,
  HostTunnelServerMessage,
  HostSubmitRunRpcParams,
  HostCommandRpcParams,
  HostReleaseResourcesRpcParams,
  HostUpstreamNotification,
  HostUpstreamEnvelope,
  HostUpstreamAckParams,
  HostReleaseRunParams,
  HostListLifecycleClaimsRpcParams,
  HostListLifecycleClaimsRpcResult,
  HostTunnelHostRpcRequest,
  HostTunnelHostRpcResponse,
  HostTunnelHostNotification,
  HostTunnelAllRpcRequest,
  HostTunnelAllRpcResponse,
  HostListRunsRpcResult,
  HostListWorkersRpcResult,
} from "./host-tunnel";

/** 隧道 WS 关闭码:Runtime Host 已被删除(撤 token),Host 收到后应退出而不是重连。
 *  (运行时值必须内联在本入口文件,原因见 common/index.ts 的 generateId 注释。) */
export const RUNTIME_TUNNEL_CLOSE_GONE = 4410;

/** RuntimeHost 控制隧道线协议版本。独立于 AGEWORK_VERSION，应用版本变化不等于协议破坏。 */
export const RUNTIME_HOST_TUNNEL_PROTOCOL_VERSION = 3;

/** Host ↔ Worker HTTP 数据面线协议版本。 */
export const RUNTIME_WORKER_HTTP_PROTOCOL_VERSION = 1;

/** 隧道双方明确声明了不兼容的协议版本；Host 应停止重连，等待升级。 */
export const RUNTIME_TUNNEL_CLOSE_INCOMPATIBLE = 4411;
