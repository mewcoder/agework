import type { Envelope } from "@agework/shared/protocol";

/**
 * run 事件的接收端（receiver）：runtime provider 产出 worker 事件，由 run 层提供实现来消费。
 * provider 只依赖此接口、不直接依赖 run 层实现，从而保持 runtime → run 零依赖。
 *
 * 这是一个 runtime 层拥有的端口（port）：定义在被调用方（runtime），由调用方（run）实现并注入，
 * 因此它属于 API 进程内的依赖倒置契约，而非 worker↔api 的线缆协议，不放在 shared/protocol。
 */
export interface RunEventReceiver {
  /** 转发 worker 上行事件。 */
  publish(envelope: Envelope<unknown>): Promise<void>;
  /** run 是否已处于终态或正在收尾（避免覆盖 finished/cancelled）。 */
  isTerminalOrFinalizing(runId: string): boolean;
  /** 强制将 run 置为 error 终态（worker 异常退出 / 心跳超时）。 */
  forceErrorStatus(runId: string, error: string): Promise<void>;
  /** 强制将 run 置为 cancelled 终态。 */
  forceCancelledStatus(runId: string): Promise<void>;
  /** 记录一次「控制指令已下发」run 事件。 */
  recordControlSent(input: {
    runId: string;
    commandId: string;
    controlType: string;
  }): Promise<void>;
}
