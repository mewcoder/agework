import type { RunChannelMessage } from "@agework/shared/protocol";

/**
 * Receiver registered by the run module so worker-host can forward worker
 * upstream events without importing run internals.
 */
export interface WorkerUpstreamReceiver {
  sendEvent(runId: string, message: RunChannelMessage): Promise<void>;
}
