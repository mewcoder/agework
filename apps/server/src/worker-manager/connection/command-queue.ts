import { Injectable, Logger, OnApplicationShutdown } from "@nestjs/common";
import type {
  RunChannelMessage,
  CommandPayload,
  OwnerCommand,
  WorkspaceFileCommandPayload,
} from "@agework/shared/protocol";
import { safeLogJson } from "../../common/logging";

type OwnerWaiter = {
  afterSeq: number;
  resolve: (commands: RunChannelMessage<CommandPayload>[]) => void;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * 内存 command 队列：写入侧由 RunDriver 经 WorkerManagerService →
 * WorkerCommandDispatcher 按 ownerId 推入；读取侧由持久容器 worker 经
 * WorkerCommandController → WorkerManagerService 按 ownerId 轮询。
 * local 实例不经过此队列（直接 IPC send）。
 *
 * ownerId 是 runtime 容器归属者的 ID（user 隔离下 = userId，workspace 隔离下 = workspaceId），
 * 一个 ownerId 对应一个可复用的持久容器，对应一个独立的命令队列分区。
 */
@Injectable()
export class WorkerCommandQueue implements OnApplicationShutdown {
  private readonly logger = new Logger(WorkerCommandQueue.name);
  /** ownerId 级队列——持久容器通过 ownerId 轮询命令。 */
  private readonly ownerQueues = new Map<
    string,
    RunChannelMessage<CommandPayload>[]
  >();
  /** ownerId 级文件命令队列——与 run 命令共用同一条长轮询连接但走独立协议类型(见 ADR-0004)。 */
  private readonly ownerFileQueues = new Map<
    string,
    OwnerCommand<WorkspaceFileCommandPayload>[]
  >();
  private readonly ownerWaiters = new Map<string, OwnerWaiter[]>();
  /** ownerId 级"代次"标识——懒生成，进程重启即归零重来，用于让 worker 察觉自己的 afterSeq 已过期。 */
  private readonly ownerEpochs = new Map<string, number>();

  /** 按 ownerId 推送命令（持久容器场景）。 */
  pushByOwnerId(
    ownerId: string,
    message: RunChannelMessage<CommandPayload>
  ): void {
    let queue = this.ownerQueues.get(ownerId);
    if (!queue) {
      queue = [];
      this.ownerQueues.set(ownerId, queue);
    }
    queue.push(message);
    this.resolveOwnerWaiters(ownerId);
    this.logger.debug(
      `push owner command ${safeLogJson({
        ownerId,
        runId: message.runId,
        seq: message.seq,
        type: message.payload.type,
        queueSize: queue.length,
      })}`
    );
  }

  /** 按 ownerId 推送文件命令(与 run 命令共用同一条长轮询连接,见 ADR-0004)。 */
  pushFileCommand(
    ownerId: string,
    command: OwnerCommand<WorkspaceFileCommandPayload>
  ): void {
    let queue = this.ownerFileQueues.get(ownerId);
    if (!queue) {
      queue = [];
      this.ownerFileQueues.set(ownerId, queue);
    }
    queue.push(command);
    this.resolveOwnerWaiters(ownerId);
    this.logger.debug(
      `push owner file command ${safeLogJson({
        ownerId,
        seq: command.seq,
        type: command.payload.type,
        commandId: command.payload.commandId,
        queueSize: queue.length,
      })}`
    );
  }

  /** 排空 ownerId 的文件命令队列(轮询时调用,一次性全部取出)。 */
  pollFileCommands(
    ownerId: string
  ): OwnerCommand<WorkspaceFileCommandPayload>[] {
    const queue = this.ownerFileQueues.get(ownerId);
    if (!queue || queue.length === 0) return [];
    this.ownerFileQueues.delete(ownerId);
    return queue;
  }

  waitForOwnerId(
    ownerId: string,
    afterSeq: number,
    timeoutMs: number
  ): Promise<RunChannelMessage<CommandPayload>[]> {
    const commands = this.pollByOwnerId(ownerId, afterSeq);
    if (commands.length > 0 || timeoutMs <= 0) {
      return Promise.resolve(commands);
    }

    return new Promise((resolve) => {
      const waiter: OwnerWaiter = {
        afterSeq,
        resolve,
        timer: setTimeout(() => {
          this.removeOwnerWaiter(ownerId, waiter);
          resolve([]);
        }, timeoutMs),
      };
      const waiters = this.ownerWaiters.get(ownerId) ?? [];
      waiters.push(waiter);
      this.ownerWaiters.set(ownerId, waiters);
    });
  }

  /** 按 ownerId 轮询命令（持久容器场景）。 */
  pollByOwnerId(
    ownerId: string,
    afterSeq: number
  ): RunChannelMessage<CommandPayload>[] {
    const queue = this.ownerQueues.get(ownerId);
    if (!queue) return [];
    // TODO: 当前假设每个 ownerId 只有一个 worker 轮询（单 worker per owner）。
    // 多 worker 并发轮询同一 ownerId 时，先到的 worker 会截断队列导致后到的 worker 漏消息。
    // 需要改为「按 (ownerId, consumerId) 切片、轮询时不截断队列」或引入 lease/ack 机制。
    const result = queue.filter((e) => e.seq > afterSeq);
    this.ownerQueues.set(ownerId, result);
    if (result.length > 0) {
      this.logger.debug(
        `poll owner commands ${safeLogJson({
          ownerId,
          afterSeq,
          returned: result.length,
          nextQueueSize: result.length,
        })}`
      );
    }
    return result;
  }

  /**
   * 进程退出时释放所有挂起的 long-poll waiter：清 timer（未 unref，会拖住干净退出）
   * 并以空命令立即 resolve，避免轮询连接和定时器悬挂。
   */
  onApplicationShutdown(): void {
    let drained = 0;
    for (const waiters of this.ownerWaiters.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.resolve([]);
        drained += 1;
      }
    }
    this.ownerWaiters.clear();
    this.ownerQueues.clear();
    this.ownerFileQueues.clear();
    if (drained > 0) {
      this.logger.log(`drained ${drained} owner command waiter(s) on shutdown`);
    }
  }

  cleanupByOwnerId(ownerId: string): void {
    this.ownerQueues.delete(ownerId);
    this.ownerFileQueues.delete(ownerId);
    const waiters = this.ownerWaiters.get(ownerId) ?? [];
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve([]);
    }
    this.ownerWaiters.delete(ownerId);
    this.ownerEpochs.delete(ownerId);
    this.logger.debug(`cleanup owner commands ${safeLogJson({ ownerId })}`);
  }

  /**
   * 某个 owner 的队列在本进程内存里的"代次"标识：懒生成，进程重启即归零重来。
   * 用 `Date.now()` 生成值，不需要严格单调或防碰撞，只需要"跟重启前的旧值大概率不同"
   * 这个弱保证。第一次被问起（不管是 push 还是 poll 触发）时懒生成并记住，之后同一个
   * ownerId 在本进程存活期间返回同一个值。
   */
  epochFor(ownerId: string): number {
    let epoch = this.ownerEpochs.get(ownerId);
    if (epoch === undefined) {
      epoch = Date.now();
      this.ownerEpochs.set(ownerId, epoch);
    }
    return epoch;
  }

  private resolveOwnerWaiters(ownerId: string): void {
    const waiters = this.ownerWaiters.get(ownerId);
    if (!waiters?.length) return;

    // 文件命令到达时也要唤醒等待的 long-poll(即使没有 run 命令),
    // 让 endpoint handler 有机会排空文件命令队列(见 ADR-0004)。
    const hasFileCommands = (this.ownerFileQueues.get(ownerId)?.length ?? 0) > 0;

    const remaining: OwnerWaiter[] = [];
    for (const waiter of waiters) {
      const commands = this.pollByOwnerId(ownerId, waiter.afterSeq);
      if (commands.length > 0 || hasFileCommands) {
        clearTimeout(waiter.timer);
        waiter.resolve(commands);
      } else {
        remaining.push(waiter);
      }
    }

    if (remaining.length > 0) {
      this.ownerWaiters.set(ownerId, remaining);
    } else {
      this.ownerWaiters.delete(ownerId);
    }
  }

  private removeOwnerWaiter(
    ownerId: string,
    waiterToRemove: OwnerWaiter
  ): void {
    const waiters = this.ownerWaiters.get(ownerId);
    if (!waiters) return;
    const remaining = waiters.filter((waiter) => waiter !== waiterToRemove);
    if (remaining.length > 0) {
      this.ownerWaiters.set(ownerId, remaining);
    } else {
      this.ownerWaiters.delete(ownerId);
    }
  }
}
