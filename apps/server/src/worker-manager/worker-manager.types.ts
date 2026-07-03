import type { RunChannelMessage } from "@agework/shared/protocol";

/**
 * Receiver registered by the run module so worker-manager can forward worker
 * upstream events without importing run internals.
 */
export interface WorkerUpstreamPort {
  sendEvent(runId: string, message: RunChannelMessage): Promise<void>;
  /** 终结一个还未到终态的 run(worker 心跳超时被 fence 掉时调用)。 */
  notifyWorkerLost(runId: string, reason: string): Promise<void>;
}
