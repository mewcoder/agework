import type { ControlPayload, Envelope } from "@agework/shared/protocol";

/** 构造下一个 command envelope 并递增 seq 计数器。
 *  @param seqOwnerId - runId（Local 模式）或 ownerId（Docker 模式），用于 seq 计数器分区。
 *
 *  注：envelope.type 仍为 "control"（协议层契约），业务层叫 command。 */
export function nextCommandEnvelope(
  commandSeqs: Map<string, number>,
  seqOwnerId: string,
  runId: string,
  payload: ControlPayload
): Envelope<ControlPayload> {
  const seq = (commandSeqs.get(seqOwnerId) ?? 0) + 1;
  commandSeqs.set(seqOwnerId, seq);
  return {
    runId,
    seq,
    type: "control",
    payload: payload,
    ts: new Date().toISOString(),
  };
}
