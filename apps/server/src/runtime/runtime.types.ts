import type {
  RuntimeInstanceRef,
  RuntimeLaunchContext,
} from "@agework/providers";

/**
 * server 与执行侧的唯一控制面边界:起/停/毁 worker 载体。
 * 两个实现:`LocalRuntime`(Managed,in-process)/ `RemoteRuntime`(Registered,隧道 RPC,Phase 2)。
 * worker 的 event/command 不走此接口——worker 出站直连 server 事件端点(worker-manager 数据面)。
 */
export interface Runtime {
  /** 建环境 + 起 worker,返回运行时实例 id。 */
  start(ctx: RuntimeLaunchContext): Promise<{ runtimeInstanceId: string }>;
  /** owner 仍在:停 worker,保留载体。 */
  stop(ref: RuntimeInstanceRef): Promise<void> | void;
  /** owner 永久消失:删除载体。 */
  destroy(ref: RuntimeInstanceRef): Promise<void> | void;
}
