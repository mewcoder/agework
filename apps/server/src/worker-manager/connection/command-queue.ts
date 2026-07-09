import { Injectable, Logger, OnApplicationShutdown } from "@nestjs/common";
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
 * 内存 command 队列：写入侧由 RunDriver 经 WorkerManagerService →
 * WorkerCommandDispatcher 按 workerId 推入；读取侧由持久容器 worker 经
 * WorkerCommandController → WorkerManagerService 按 workerId 轮询。
 * native 实例不经过此队列（直接 IPC send）。
 *
 * workerId 是 Worker.id 主键（协议身份,见 Ticket 03）,
 * 一个 workerId 对应一个可复用的持久容器,对应一个独立的命令队列分区。
 */
@Injectable()
export class WorkerCommandQueue implements OnApplicationShutdown {
  private readonly logger = new Logger(WorkerCommandQueue.name);
  /** workerId 级队列——持久容器通过 workerId 轮询命令。 */
  private readonly workerQueues = new Map<
    string,
    RunChannelMessage<CommandPayload>[]
  >();
  private readonly workerWaiters = new Map<string, WorkerWaiter[]>();
  /** workerId 级"代次"标识——懒生成,进程重启即归零重来,用于让 worker 察觉自己的 afterSeq 已过期。 */
  private readonly workerEpochs = new Map<string, number>();

  /** 按 workerId 推送命令（持久容器场景）。 */
  pushByWorkerId(
    workerId: string,
    message: RunChannelMessage<CommandPayload>
  ): void {
    let queue = this.workerQueues.get(workerId);
    if (!queue) {
      queue = [];
      this.workerQueues.set(workerId, queue);
    }
    queue.push(message);
    this.resolveWorkerWaiters(workerId);
    this.logger.debug("push worker command", {
      workerId,
      runId: message.runId,
      seq: message.seq,
      type: message.payload.type,
      queueSize: queue.length,
    });
  }


  waitForWorkerId(
    workerId: string,
    afterSeq: number,
    timeoutMs: number
  ): Promise<RunChannelMessage<CommandPayload>[]> {
    const commands = this.pollByWorkerId(workerId, afterSeq);
    if (commands.length > 0 || timeoutMs <= 0) {
      return Promise.resolve(commands);
    }

    return new Promise((resolve) => {
      const waiter: WorkerWaiter = {
        afterSeq,
        resolve,
        timer: setTimeout(() => {
          this.removeWorkerWaiter(workerId, waiter);
          resolve([]);
        }, timeoutMs),
      };
      const waiters = this.workerWaiters.get(workerId) ?? [];
      waiters.push(waiter);
      this.workerWaiters.set(workerId, waiters);
    });
  }

  /** 按 workerId 轮询命令（持久容器场景）。 */
  pollByWorkerId(
    workerId: string,
    afterSeq: number
  ): RunChannelMessage<CommandPayload>[] {
    const queue = this.workerQueues.get(workerId);
    if (!queue) return [];
    const result = queue.filter((e) => e.seq > afterSeq);
    this.workerQueues.set(workerId, result);
    if (result.length > 0) {
      this.logger.debug("poll worker commands", {
        workerId,
        afterSeq,
        returned: result.length,
        nextQueueSize: result.length,
      });
    }
    return result;
  }

  /**
   * 进程退出时释放所有挂起的 long-poll waiter：清 timer（未 unref，会拖住干净退出）
   * 并以空命令立即 resolve，避免轮询连接和定时器悬挂。
   */
  onApplicationShutdown(): void {
    let drained = 0;
    for (const waiters of this.workerWaiters.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.resolve([]);
        drained += 1;
      }
    }
    this.workerWaiters.clear();
    this.workerQueues.clear();
    if (drained > 0) {
      this.logger.log(`drained ${drained} worker command waiter(s) on shutdown`);
    }
  }

  cleanupByWorkerId(workerId: string): void {
    this.workerQueues.delete(workerId);
    const waiters = this.workerWaiters.get(workerId) ?? [];
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve([]);
    }
    this.workerWaiters.delete(workerId);
    this.workerEpochs.delete(workerId);
    this.logger.debug("cleanup worker commands", { workerId });
  }

  /**
   * 某个 worker 的队列在本进程内存里的"代次"标识：懒生成，进程重启即归零重来。
   * 用 `Date.now()` 生成值，不需要严格单调或防碰撞，只需要"跟重启前的旧值大概率不同"
   * 这个弱保证。第一次被问起（不管是 push 还是 poll 触发）时懒生成并记住，之后同一个
   * workerId 在本进程存活期间返回同一个值。
   */
  epochFor(workerId: string): number {
    let epoch = this.workerEpochs.get(workerId);
    if (epoch === undefined) {
      epoch = Date.now();
      this.workerEpochs.set(workerId, epoch);
    }
    return epoch;
  }

  private resolveWorkerWaiters(workerId: string): void {
    const waiters = this.workerWaiters.get(workerId);
    if (!waiters?.length) return;

    const remaining: WorkerWaiter[] = [];
    for (const waiter of waiters) {
      const commands = this.pollByWorkerId(workerId, waiter.afterSeq);
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

  private removeWorkerWaiter(
    workerId: string,
    waiterToRemove: WorkerWaiter
  ): void {
    const waiters = this.workerWaiters.get(workerId);
    if (!waiters) return;
    const remaining = waiters.filter((waiter) => waiter !== waiterToRemove);
    if (remaining.length > 0) {
      this.workerWaiters.set(workerId, remaining);
    } else {
      this.workerWaiters.delete(workerId);
    }
  }
}
