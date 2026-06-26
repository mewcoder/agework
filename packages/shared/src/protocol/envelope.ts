/**
 * Unified message envelope used by RuntimeChannel (Ipc/Http).
 * `seq` is monotonically increasing per `runId` and is the basis for
 * at-least-once delivery + idempotent dedup (key = `runId:seq`).
 *
 * Wire-format note: the `type` field is the on-the-wire discriminant
 * (e.g. `"command"`, `"command.trace"`, `"agui.event"`). It is part of
 * the cross-process protocol shared by API and worker — changes here
 * require a coordinated deploy on both sides.
 */
export interface Envelope<T = unknown> {
  runId: string;
  seq: number;
  type: string;
  payload: T;
  ts: string;
}
