import type { RunChannelMessage } from "./run-channel-message";
import type { CommandPayload } from "./channel";
import type {
  OwnerCommand,
  WorkspaceFileCommandPayload,
} from "./workspace-file-command";

export type { RunChannelMessage } from "./run-channel-message";

/** 构造下一个 command message 并递增 seq 计数器。
 *  @param seqOwnerId - runId（Local 模式）或 ownerId（Docker 模式），用于 seq 计数器分区。 */
export function nextCommandMessage(
  commandSeqs: Map<string, number>,
  seqOwnerId: string,
  runId: string,
  payload: CommandPayload
): RunChannelMessage<CommandPayload> {
  const seq = (commandSeqs.get(seqOwnerId) ?? 0) + 1;
  commandSeqs.set(seqOwnerId, seq);
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
export const WORKER_OWNER_ID_HEADER = "x-agework-owner-id";

export type {
  AGUIEvent,
  AgentType,
  RunStatus,
  RunStatusPayload,
  RunUsage,
  ArtifactRefPayload,
  RunConfig,
  SystemAgentProviderConfig,
  CustomAgentProviderConfig,
  AgentProviderConfig,
  CommandPayload,
  CommandResultPayload,
  CommandTracePayload,
  UpstreamMessage,
  Unsubscribe,
  RuntimeChannel,
  WorkerExecutionHandle,
  WorkerExecutionStartInput,
  WorkerRegisterRequest,
  AcquireInstanceResult,
  IsolationScope,
  RuntimeSpec,
  LocalRuntimeSpec,
  SandboxRuntimeSpec,
  SandboxPlacementInfo,
} from "./channel";
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
  ListFilesPayload,
  ReadFilePayload,
  WorkspaceFileCommandPayload,
  FileEntryType,
  FileEntry,
  ListFilesResult,
  ReadFileResult,
  WorkspaceFileCommandError,
  WorkspaceFileCommandResult,
  OwnerCommand,
} from "./workspace-file-command";

/**
 * 构造下一个 owner-scoped 命令信封并递增 seq 计数器。
 *
 * 注意:本函数为运行时值导出,必须内联在本入口文件中,不可跨文件 re-export ——
 * shared 包以源码形式被消费(exports 指向 src 源文件,无 dist),NodeNext 运行时
 * 解析跨文件 re-export 需要显式扩展名,而磁盘上是 .ts,会导致 ERR_MODULE_NOT_FOUND。
 */
export function nextOwnerCommand(
  seqs: Map<string, number>,
  ownerId: string,
  payload: WorkspaceFileCommandPayload
): OwnerCommand<WorkspaceFileCommandPayload> {
  const seq = (seqs.get(ownerId) ?? 0) + 1;
  seqs.set(ownerId, seq);
  return {
    seq,
    payload,
    ts: new Date().toISOString(),
  };
}
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
  RuntimeTunnelRpcResponse,
} from "./runtime-tunnel";

/** 隧道 WS 关闭码:runtime 已被删除(撤 token),manager 收到后应退出而不是重连。
 *  (运行时值必须内联在本入口文件,原因见 common/index.ts 的 generateId 注释。) */
export const RUNTIME_TUNNEL_CLOSE_GONE = 4410;
