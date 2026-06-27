import type {
  CommandPayload,
  RunChannelMessage,
  WorkerExecutionHandle,
  WorkerExecutionStartInput,
} from "@agework/shared/protocol";

/**
 * per-run 执行通道：把 RuntimeTarget + RunConfig 跑成一次 run execution。
 *
 * Runtime 只提供运行环境；真正的 worker 启动、命令下发、取消和 run 级 cleanup
 * 由 runs 层的 RunExecutor 实现。
 */
export interface RunExecutor {
  readonly type: string;
  setRunEventReceiver(receiver: RunEventReceiver): void;
  start(input: WorkerExecutionStartInput): WorkerExecutionHandle;
  sendCommand(handle: WorkerExecutionHandle, command: CommandPayload): void;
  cancel(handle: WorkerExecutionHandle): void;
  /** 强制终止单次 run 的执行会话；不得停止可复用 runtime resource。 */
  terminateExecution?(runId: string, reason: string): void;
  cleanup(runId: string): void;
  /** 服务重启后清理中断执行的残留（如 local worker pid / sandbox runtime resource）。 */
  cleanupInterruptedExecution?(runtimeInstanceId: string): Promise<void>;
}

export interface RunEventReceiver {
  /** 转发上行 event（local 模式 IPC 入口；sandbox 模式直走 worker-host）。 */
  sendEvent(
    runId: string,
    message: RunChannelMessage<unknown>
  ): Promise<void>;
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
