import type { CommandPayload, Envelope } from "@agework/shared/protocol";

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
