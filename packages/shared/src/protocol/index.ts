import type { RunChannelMessage } from "./run-channel-message";
import type { CommandPayload } from "./channel";

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
  RuntimeTarget,
  WorkerExecutionHandle,
  WorkerExecutionStartInput,
  WorkerRegisterRequest,
  AcquireInstanceResult,
  IsolationScope,
  RuntimePlacement,
  LocalRuntimePlacement,
  SandboxRuntimePlacement,
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
