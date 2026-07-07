import type { RunChannelMessage } from "@agework/shared/protocol";

/**
 * RunDriver 用来上报 run 事件的反向端口：worker 上行事件、异常、取消通知
 * 经这个端口回流给 run 层的事件入口。只承载执行回流,记账类落库不走这里。
 */
export interface RunEventPort {
  /** 转发上行 event（local 模式 IPC 入口；sandbox 模式直走 worker-manager）。 */
  sendEvent(runId: string, message: RunChannelMessage<unknown>): Promise<void>;
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
