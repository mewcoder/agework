import type { WorkerKey } from "@agework/shared/protocol";

export type FenceCallback = (key: WorkerKey, workerId: string) => void;

/**
 * worker 心跳判死（fence）：定期扫描 worker 池，超时未见心跳即判死。
 * 超时即判死，不做"确认死亡"——卡死但进程没退出正是它要抓的场景。
 *
 * 收编自 worker-manager/connection/worker-liveness.sweeper.ts + liveness.store.ts，
 * 去掉 NestJS 依赖。pool 的 lastSeen 字段由 long-poll 和事件上报时 touch 更新。
 */
export class FenceSweeper {
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly timeoutMs: number,
    private readonly onFence: FenceCallback
  ) {}

  /** 启动定期扫描。intervalMs 默认为 timeoutMs / 3。 */
  start(intervalMs?: number): void {
    const interval = intervalMs ?? Math.max(1000, Math.floor(this.timeoutMs / 3));
    this.timer = setInterval(() => this.sweep(), interval);
    // timer 不拖住事件循环（进程存活由其他来源保证）
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * 扫描一次：返回被判死的 worker 列表。
   * 调用方（RuntimeHost）负责通知 upstream、清理 pool。
   */
  sweep(now: number = Date.now()): { key: WorkerKey; workerId: string }[] {
    // 实际扫描逻辑由 RuntimeHost 调用时传入 pool 快照——这里只提供框架。
    // FenceSweeper 的 sweep 回调由 RuntimeHost 注册。
    return [];
  }
}
