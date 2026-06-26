import { Injectable, Logger } from "@nestjs/common";
import type { Envelope, CommandPayload } from "@agework/shared/protocol";
import type { CommandSentRecorder } from "./command-sent-recorder.port";
import { errorLogFields, safeLogJson } from "../common/logging";

type OwnerWaiter = {
  afterSeq: number;
  resolve: (commands: Envelope<CommandPayload>[]) => void;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * 内存 command 队列：SandboxRuntimeProvider 经 WorkerCommandDispatcher 按 ownerId
 * 写入 command，持久容器 worker 经 WorkerCommandController 按 ownerId 轮询读取。
 * LocalRuntimeProvider 不经过此队列（直接 IPC send）。
 *
 * ownerId 是 runtime 容器归属者的 ID（user 隔离下 = userId，workspace 隔离下 = workspaceId），
 * 一个 ownerId 对应一个可复用的持久容器，对应一个独立的命令队列分区。
 */
@Injectable()
export class WorkerCommandQueue {
  private readonly logger = new Logger(WorkerCommandQueue.name);
  /** ownerId 级队列——持久容器通过 ownerId 轮询命令。 */
  private readonly ownerQueues = new Map<
    string,
    Envelope<CommandPayload>[]
  >();
  private readonly ownerWaiters = new Map<string, OwnerWaiter[]>();
  private recorder!: CommandSentRecorder;

  setCommandSentRecorder(recorder: CommandSentRecorder): void {
    this.recorder = recorder;
  }

  /** 按 ownerId 推送命令（持久容器场景）。 */
  pushByOwnerId(
    ownerId: string,
    envelope: Envelope<CommandPayload>
  ): void {
    let queue = this.ownerQueues.get(ownerId);
    if (!queue) {
      queue = [];
      this.ownerQueues.set(ownerId, queue);
    }
    queue.push(envelope);
    this.resolveOwnerWaiters(ownerId);
    this.recordEnqueued(envelope.runId, envelope);
    this.logger.debug(
      `push owner command ${safeLogJson({
        ownerId,
        runId: envelope.runId,
        seq: envelope.seq,
        type: envelope.payload.type,
        queueSize: queue.length,
      })}`
    );
  }

  waitForOwnerId(
    ownerId: string,
    afterSeq: number,
    timeoutMs: number
  ): Promise<Envelope<CommandPayload>[]> {
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
  ): Envelope<CommandPayload>[] {
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

  /** command 入队即记一条 sent trace，commandId 供 worker 上行的 received/handled/failed 回连。 */
  private recordEnqueued(
    runId: string,
    envelope: Envelope<CommandPayload>
  ): void {
    if (!runId) return;
    const payload = envelope.payload;
    this.recorder
      .recordCommandSent({
        runId,
        commandId: payload.commandId,
        commandType: payload.type,
      })
      .catch((err) =>
        this.logger.warn(
          `record command sent failed ${safeLogJson({
            runId,
            commandType: payload.type,
            ...errorLogFields(err),
          })}`
        )
      );
  }

  cleanupByOwnerId(ownerId: string): void {
    this.ownerQueues.delete(ownerId);
    const waiters = this.ownerWaiters.get(ownerId) ?? [];
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve([]);
    }
    this.ownerWaiters.delete(ownerId);
    this.logger.debug(
      `cleanup owner commands ${safeLogJson({ ownerId })}`
    );
  }

  private resolveOwnerWaiters(ownerId: string): void {
    const waiters = this.ownerWaiters.get(ownerId);
    if (!waiters?.length) return;

    const remaining: OwnerWaiter[] = [];
    for (const waiter of waiters) {
      const commands = this.pollByOwnerId(ownerId, waiter.afterSeq);
      if (commands.length > 0) {
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
