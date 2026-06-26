import type { Envelope } from "./envelope";
import type { CommandPayload } from "./channel";

export type { Envelope } from "./envelope";

/** 构造下一个 command envelope 并递增 seq 计数器。
 *  @param seqOwnerId - runId（Local 模式）或 ownerId（Docker 模式），用于 seq 计数器分区。 */
export function nextCommandEnvelope(
  commandSeqs: Map<string, number>,
  seqOwnerId: string,
  runId: string,
  payload: CommandPayload
): Envelope<CommandPayload> {
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
export type {
  AGUIEvent,
  AgentType,
  RunStatus,
  RunStatusPayload,
  RunUsage,
  HeartbeatPayload,
  ArtifactRefPayload,
  RunConfig,
  SystemAgentProviderConfig,
  CustomAgentProviderConfig,
  AgentProviderConfig,
  CommandPayload,
  CommandTracePayload,
  UpstreamMessage,
  Unsubscribe,
  RuntimeChannel,
  RuntimeTarget,
  WorkerExecutionHandle,
  WorkerExecutionStartInput,
  IsolationScope,
  RuntimePlacement,
  LocalRuntimePlacement,
  SandboxRuntimePlacement,
  SandboxPlacementInfo,
} from "./channel";
