/**
 * Unified message envelope used by RuntimeTransport (Ipc/Http).
 * `seq` is monotonically increasing per `runId` and is the basis for
 * at-least-once delivery + idempotent dedup (key = `runId:seq`).
 */
export interface Envelope<T = unknown> {
  runId: string;
  seq: number;
  type: string;
  payload: T;
  ts: string;
}
