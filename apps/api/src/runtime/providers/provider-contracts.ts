export type RuntimeOwnerSessionCleanup = (ownerId: string) => void;

/**
 * Runtime 驱动的 runtime 实例（进程/容器）生命周期面，与 per-run 执行正交：
 * runtime 实例可跨多个 run 复用、独立于单次 run 存活。由 RuntimeService /
 * RuntimeInstanceLifecycleUseCase / RunRecoveryUseCase 经 registry 驱动。
 */
export interface RuntimeInstanceManager {
  readonly type: string;
  /** 服务重启后，根据持久化的 runtimeInstanceId 终止孤儿 run 对应的进程/容器。幂等。 */
  recoverOrphan(runtimeInstanceId: string): Promise<void>;
  /** 停止并删除指定 owner 对应的持久容器/沙箱（仅持久实例 provider）。 */
  shutdownRuntimeInstance?(ownerId: string): void;
  /** 由上层组合根注入 owner 级附属会话清理（如 worker-host command session）。 */
  setOwnerSessionCleanup?(cleanup: RuntimeOwnerSessionCleanup): void;
}

export type RuntimeProvider = RuntimeInstanceManager;
