import type {
  RunChannelMessage,
  CommandPayload,
} from "@agework/shared/protocol";

type WorkerWaiter = {
  afterSeq: number;
  resolve: (commands: RunChannelMessage<CommandPayload>[]) => void;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * 命令信箱：workerId 级的内存命令队列 + long-poll 支持。
 *
 * 收编自 worker-manager/connection/command-queue.ts，去掉 NestJS 依赖。
 * 写入侧由 RuntimeHost 按 workerId 推入；读取侧由 worker 经 HTTP 长轮询拉取。
 */
export class CommandMailbox {
  private readonly workerQueues = new Map<
    string,
    RunChannelMessage<CommandPayload>[]
  >();
  private readonly workerWaiters = new Map<string, WorkerWaiter[]>();
  /** workerId 级"代次"标识——进程重启即归零，用于让 worker 察觉 afterSeq 已过期。 */
  private readonly workerEpochs = new Map<string, number>();
  private readonly commandSeqs = new Map<string, number>();

  enqueue(
    workerId: string,
    runId: string,
    payload: CommandPayload
  ): RunChannelMessage<CommandPayload> {
    const seq = (this.commandSeqs.get(workerId) ?? 0) + 1;
    this.commandSeqs.set(workerId, seq);
    const message: RunChannelMessage<CommandPayload> = {
      runId,
      seq,
      type: "command",
      payload,
      ts: new Date().toISOString(),
    };
    this.push(workerId, message);
    return message;
  }

  /** 按 workerId 推送命令。 */
  push(workerId: string, message: RunChannelMessage<CommandPayload>): void {
    let queue = this.workerQueues.get(workerId);
    if (!queue) {
      queue = [];
      this.workerQueues.set(workerId, queue);
    }
    queue.push(message);
    this.resolveWaiters(workerId);
  }

  /** 按 workerId 长轮询命令。 */
  poll(
    workerId: string,
    afterSeq: number,
    timeoutMs: number
  ): Promise<RunChannelMessage<CommandPayload>[]> {
    const commands = this.pollImmediate(workerId, afterSeq);
    if (commands.length > 0 || timeoutMs <= 0) {
      return Promise.resolve(commands);
    }
    return new Promise((resolve) => {
      const waiter: WorkerWaiter = {
        afterSeq,
        resolve,
        timer: setTimeout(() => {
          this.removeWaiter(workerId, waiter);
          resolve([]);
        }, timeoutMs),
      };
      const waiters = this.workerWaiters.get(workerId) ?? [];
      waiters.push(waiter);
      this.workerWaiters.set(workerId, waiters);
    });
  }

  /** 按 workerId 立即轮询（不等待）。 */
  pollImmediate(
    workerId: string,
    afterSeq: number
  ): RunChannelMessage<CommandPayload>[] {
    const queue = this.workerQueues.get(workerId);
    if (!queue) return [];
    const result = queue.filter((e) => e.seq > afterSeq);
    this.workerQueues.set(workerId, result);
    return result;
  }

  /** 清理 workerId 的全部队列和 waiter。 */
  cleanup(workerId: string): void {
    this.workerQueues.delete(workerId);
    const waiters = this.workerWaiters.get(workerId) ?? [];
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve([]);
    }
    this.workerWaiters.delete(workerId);
    this.workerEpochs.delete(workerId);
    this.commandSeqs.delete(workerId);
  }

  /** 进程退出时释放所有挂起的 waiter。 */
  drain(): void {
    for (const waiters of this.workerWaiters.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.resolve([]);
      }
    }
    this.workerWaiters.clear();
    this.workerQueues.clear();
    this.workerEpochs.clear();
    this.commandSeqs.clear();
  }

  /**
   * workerId 的队列代次标识：懒生成，进程重启即归零。
   * worker 察觉 epoch 变化后重置 afterSeq 重新拉取。
   */
  epochFor(workerId: string): number {
    let epoch = this.workerEpochs.get(workerId);
    if (epoch === undefined) {
      epoch = Date.now();
      this.workerEpochs.set(workerId, epoch);
    }
    return epoch;
  }

  private resolveWaiters(workerId: string): void {
    const waiters = this.workerWaiters.get(workerId);
    if (!waiters?.length) return;
    const remaining: WorkerWaiter[] = [];
    for (const waiter of waiters) {
      const commands = this.pollImmediate(workerId, waiter.afterSeq);
      if (commands.length > 0) {
        clearTimeout(waiter.timer);
        waiter.resolve(commands);
      } else {
        remaining.push(waiter);
      }
    }
    if (remaining.length > 0) {
      this.workerWaiters.set(workerId, remaining);
    } else {
      this.workerWaiters.delete(workerId);
    }
  }

  private removeWaiter(
    workerId: string,
    waiterToRemove: WorkerWaiter
  ): void {
    const waiters = this.workerWaiters.get(workerId);
    if (!waiters) return;
    const remaining = waiters.filter((w) => w !== waiterToRemove);
    if (remaining.length > 0) {
      this.workerWaiters.set(workerId, remaining);
    } else {
      this.workerWaiters.delete(workerId);
    }
  }
}
