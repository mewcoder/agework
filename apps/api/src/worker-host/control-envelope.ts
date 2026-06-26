import type { ControlPayload, Envelope } from "@agework/shared/protocol";

/** 构造下一个 control envelope 并递增 seq 计数器。
 *  @param seqScopeKey - runId（Local 模式）或 workspaceId（Docker 模式），用于 seq 计数器分区 */
export function nextControlEnvelope(
  controlSeqs: Map<string, number>,
  seqScopeKey: string,
  runId: string,
  control: ControlPayload
): Envelope<ControlPayload> {
  const seq = (controlSeqs.get(seqScopeKey) ?? 0) + 1;
  controlSeqs.set(seqScopeKey, seq);
  return {
    runId,
    seq,
    type: "control",
    payload: control,
    ts: new Date().toISOString(),
  };
}
