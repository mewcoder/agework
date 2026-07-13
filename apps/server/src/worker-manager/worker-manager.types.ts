import type { RunChannelMessage } from "@agework/shared/protocol";

/**
 * Receiver registered by the run module so worker-manager can forward worker
 * upstream events without importing run internals.
 */
export interface WorkerUpstreamPort {
  sendEvent(runId: string, message: RunChannelMessage): Promise<void>;
}

/**
 * `RuntimeHostContract`（@agework/shared/protocol）的注入 token。
 * run 模块经它注入契约接口，看不见实现类——Phase 1 由本模块的
 * RuntimeHostAdapter 兑现，Phase 2 换成 apps/runtime 的真实现，token 不变。
 */
export const RUNTIME_HOST_CONTRACT = Symbol("RuntimeHostContract");
