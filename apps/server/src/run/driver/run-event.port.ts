/**
 * RunDriver 用来上报 run 事件的反向端口：worker 异常、取消通知经这个端口
 * 回流给 run 层的事件入口。只承载执行回流,记账类落库不走这里;上行 event
 * 转发不经 RunDriver,走 worker-manager 的 WorkerUpstreamPort。
 */
export interface RunEventPort {
  /**
   * 通知 run：worker 异常（进程崩溃 / 心跳超时 / sandbox 创建失败等）。
   * run 自行判断当前状态并决定是否转为 error 终态。
   */
  notifyWorkerError(runId: string, error: string): Promise<void>;
  /**
   * 通知 run：取消请求在 runtime 实例 ready 之前到达。
   * run 自行判断当前状态并决定是否转为 cancelled 终态。
   */
  notifyCancelledBeforeReady(runId: string): Promise<void>;
}
