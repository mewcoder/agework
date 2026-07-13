import type { RunChannelMessage } from "./run-channel-message";
import type { CommandPayload } from "./channel";

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
  RuntimeChannel,
  WorkerExecutionHandle,
  WorkerExecutionStartInput,
  WorkerRegisterRequest,
  AcquireInstanceResult,
  IsolationScope,
  RuntimeSpec,
  NativeRuntimeSpec,
  SandboxRuntimeSpec,
  SandboxPlacementInfo,
} from "./channel";
export type {
  WorkerScope,
  Isolation,
  OwnerKey,
  WorkerKey,
  RunPlacement,
  SubmitRunInput,
  ExecutionRef,
  WorkerSnapshot,
  RuntimeHostContract,
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
} from "./runtime-host";

// ── owner/worker key 构造器(运行时值必须内联在本入口文件,原因见
//    common/index.ts 的 generateId 注释;类型定义在 runtime-host.ts) ──

export function workspaceOwnerKey(
  workspaceId: string
): `workspace:${string}` {
  return `workspace:${workspaceId}`;
}

export function userOwnerKey(userId: string): `user:${string}` {
  return `user:${userId}`;
}

export function workerKey(
  owner: `workspace:${string}` | `user:${string}`,
  isolation: string
): `${"workspace" | "user"}:${string}#${string}` {
  return `${owner}#${isolation}` as `${"workspace" | "user"}:${string}#${string}`;
}

/** 拆 owner 键。仅接受上面构造器产出的形状，坏输入直接抛错（编程错误，不兜）。 */
export function parseOwnerKey(
  owner: `workspace:${string}` | `user:${string}`
): {
  scope: "workspace" | "user";
  id: string;
} {
  const sep = owner.indexOf(":");
  const scope = owner.slice(0, sep);
  const id = owner.slice(sep + 1);
  if ((scope !== "workspace" && scope !== "user") || !id) {
    throw new Error(`invalid owner key: ${String(owner)}`);
  }
  return { scope, id };
}
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
  RuntimeCapabilities,
  RuntimeTunnelClientMessage,
  RuntimeTunnelHeartbeatMessage,
  RuntimeTunnelRegisterMessage,
  RuntimeTunnelRegisteredMessage,
  RuntimeTunnelServerMessage,
  RuntimeLaunchRpcParams,
  RuntimeInstanceRefRpcParams,
  RuntimeTunnelRpcRequest,
  RuntimeLaunchRpcResult,
  RuntimeDetectEnvRpcParams,
  RuntimeDetectEnvRpcResult,
  RuntimeListDirRpcParams,
  RuntimeListDirRpcResult,
  RuntimeCreateDirRpcParams,
  RuntimeCreateDirRpcResult,
  RuntimeListFilesRpcParams,
  RuntimeListFilesRpcResult,
  RuntimeReadFileRpcParams,
  RuntimeReadFileRpcResult,
  RuntimeListChangedFilesRpcParams,
  RuntimeListChangedFilesRpcResult,
  RuntimeReadFileDiffRpcParams,
  RuntimeReadFileDiffRpcResult,
  RuntimeSearchFilesRpcParams,
  RuntimeSearchFilesRpcResult,
  RuntimeTunnelRpcResponse,
  HostSubmitRunRpcParams,
  HostCommandRpcParams,
  HostReleaseOwnerRpcParams,
  HostUpstreamNotification,
  RuntimeTunnelHostRpcRequest,
  RuntimeTunnelHostRpcResponse,
  RuntimeTunnelHostNotification,
  RuntimeTunnelAllRpcRequest,
  RuntimeTunnelAllRpcResponse,
  HostListWorkersRpcResult,
} from "./runtime-tunnel";

/** 隧道 WS 关闭码:runtime 已被删除(撤 token),manager 收到后应退出而不是重连。
 *  (运行时值必须内联在本入口文件,原因见 common/index.ts 的 generateId 注释。) */
export const RUNTIME_TUNNEL_CLOSE_GONE = 4410;
