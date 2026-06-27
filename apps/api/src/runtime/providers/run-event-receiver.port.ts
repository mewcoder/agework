import type { RunChannelMessage } from "@agework/shared/protocol";

/**
 * runtime 侧 run 事件/通知出口：runtime provider 把 worker 上行事件转发给 run，
 * 并在检测到 worker 异常或取消-before-ready 时**通知** run（不操纵 run 状态机——
 * 是否转终态、转哪个终态由 run 自行决定，runtime 只告知事实）。
 *
 * 这是一个 runtime 层拥有的端口（port）：定义在被调用方（runtime），由调用方（run）
 * 实现并注入，属于 API 进程内的依赖倒置契约，而非 worker↔api 的线缆协议，不放在 shared/protocol。
 */
export interface RunEventReceiver {
  /** 转发上行 event（local 模式 IPC 入口；sandbox 模式直走 worker-host）。 */
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
  /** 记录一次「命令已下发」run 事件。 */
  recordCommandSent(input: {
    runId: string;
    commandId: string;
    commandType: string;
  }): Promise<void>;
}
