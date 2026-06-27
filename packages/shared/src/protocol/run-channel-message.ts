/**
 * Internal run-scoped message record used after worker RPC has been normalized.
 * `seq` is monotonically increasing per run/owner stream and drives idempotent
 * processing inside API and worker internals.
 */
export interface RunChannelMessage<T = unknown> {
  runId: string;
  seq: number;
  type: string;
  payload: T;
  ts: string;
}
