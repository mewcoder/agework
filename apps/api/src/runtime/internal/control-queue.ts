import { Injectable, Logger } from "@nestjs/common";
import type { Envelope, ControlPayload } from "@agework/shared/protocol";
import type { RunEventReceiver } from "../providers/run-event-receiver";
import { errorLogFields, safeLogJson } from "../../common/logging";

type WorkspaceWaiter = {
  afterSeq: number;
  resolve: (controls: Envelope<ControlPayload>[]) => void;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * 内存 control 队列，供 DockerRuntimeProvider 写入 control，
 * RuntimeInternalController.pollControls() 读取。
 * LocalRuntimeProvider 不经过此队列（直接 IPC send）。
 */
@Injectable()
export class RuntimeControlQueue {
  private readonly logger = new Logger(RuntimeControlQueue.name);
  private readonly queues = new Map<string, Envelope<ControlPayload>[]>();
  /** workspace 级队列——持久容器通过 workspaceId 轮询控制消息。 */
  private readonly workspaceQueues = new Map<
    string,
    Envelope<ControlPayload>[]
  >();
  private readonly workspaceWaiters = new Map<string, WorkspaceWaiter[]>();
  private receiver!: RunEventReceiver;

  setRunEventReceiver(receiver: RunEventReceiver): void {
    this.receiver = receiver;
  }

  push(runId: string, envelope: Envelope<ControlPayload>): void {
    let queue = this.queues.get(runId);
    if (!queue) {
      queue = [];
      this.queues.set(runId, queue);
    }
    queue.push(envelope);
    this.recordEnqueued(runId, envelope);
    this.logger.debug(
      `push run control ${safeLogJson({
        runId,
        seq: envelope.seq,
        type: envelope.payload.type,
        queueSize: queue.length,
      })}`
    );
  }

  /** 按 workspaceId 推送控制消息（持久容器场景）。 */
  pushForWorkspace(
    workspaceId: string,
    envelope: Envelope<ControlPayload>
  ): void {
    let queue = this.workspaceQueues.get(workspaceId);
    if (!queue) {
      queue = [];
      this.workspaceQueues.set(workspaceId, queue);
    }
    queue.push(envelope);
    this.resolveWorkspaceWaiters(workspaceId);
    this.recordEnqueued(envelope.runId, envelope);
    this.logger.debug(
      `push workspace control ${safeLogJson({
        workspaceId,
        runId: envelope.runId,
        seq: envelope.seq,
        type: envelope.payload.type,
        queueSize: queue.length,
      })}`
    );
  }

  /** 获取 afterSeq 之后的 control envelopes，并删除已读取的旧条目 */
  poll(runId: string, afterSeq: number): Envelope<ControlPayload>[] {
    const queue = this.queues.get(runId);
    if (!queue) return [];

    // 只保留 afterSeq 之后的条目，已读取的旧条目随之被丢弃
    const result = queue.filter((e) => e.seq > afterSeq);
    this.queues.set(runId, result);
    if (result.length > 0) {
      this.logger.debug(
        `poll run controls ${safeLogJson({
          runId,
          afterSeq,
          returned: result.length,
          nextQueueSize: result.length,
        })}`
      );
    }
    return result;
  }

  waitForWorkspace(
    workspaceId: string,
    afterSeq: number,
    timeoutMs: number
  ): Promise<Envelope<ControlPayload>[]> {
    const controls = this.pollByWorkspace(workspaceId, afterSeq);
    if (controls.length > 0 || timeoutMs <= 0) {
      return Promise.resolve(controls);
    }

    return new Promise((resolve) => {
      const waiter: WorkspaceWaiter = {
        afterSeq,
        resolve,
        timer: setTimeout(() => {
          this.removeWorkspaceWaiter(workspaceId, waiter);
          resolve([]);
        }, timeoutMs),
      };
      const waiters = this.workspaceWaiters.get(workspaceId) ?? [];
      waiters.push(waiter);
      this.workspaceWaiters.set(workspaceId, waiters);
    });
  }

  /** 按 workspaceId 轮询控制消息（持久容器场景）。 */
  pollByWorkspace(
    workspaceId: string,
    afterSeq: number
  ): Envelope<ControlPayload>[] {
    const queue = this.workspaceQueues.get(workspaceId);
    if (!queue) return [];
    const result = queue.filter((e) => e.seq > afterSeq);
    this.workspaceQueues.set(workspaceId, result);
    if (result.length > 0) {
      this.logger.debug(
        `poll workspace controls ${safeLogJson({
          workspaceId,
          afterSeq,
          returned: result.length,
          nextQueueSize: result.length,
        })}`
      );
    }
    return result;
  }

  cleanup(runId: string): void {
    this.queues.delete(runId);
    this.logger.debug(`cleanup run controls ${safeLogJson({ runId })}`);
  }

  /** control 入队即记一条 sent trace，commandId 供 worker 上行的 received/handled/failed 回连。 */
  private recordEnqueued(
    runId: string,
    envelope: Envelope<ControlPayload>
  ): void {
    if (!runId) return;
    const control = envelope.payload;
    this.receiver
      .recordControlSent({
        runId,
        commandId: control.commandId,
        controlType: control.type,
      })
      .catch((err) =>
        this.logger.warn(
          `record control sent failed ${safeLogJson({
            runId,
            controlType: control.type,
            ...errorLogFields(err),
          })}`
        )
      );
  }

  cleanupWorkspace(workspaceId: string): void {
    this.workspaceQueues.delete(workspaceId);
    const waiters = this.workspaceWaiters.get(workspaceId) ?? [];
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve([]);
    }
    this.workspaceWaiters.delete(workspaceId);
    this.logger.debug(
      `cleanup workspace controls ${safeLogJson({ workspaceId })}`
    );
  }

  private resolveWorkspaceWaiters(workspaceId: string): void {
    const waiters = this.workspaceWaiters.get(workspaceId);
    if (!waiters?.length) return;

    const remaining: WorkspaceWaiter[] = [];
    for (const waiter of waiters) {
      const controls = this.pollByWorkspace(workspaceId, waiter.afterSeq);
      if (controls.length > 0) {
        clearTimeout(waiter.timer);
        waiter.resolve(controls);
      } else {
        remaining.push(waiter);
      }
    }

    if (remaining.length > 0) {
      this.workspaceWaiters.set(workspaceId, remaining);
    } else {
      this.workspaceWaiters.delete(workspaceId);
    }
  }

  private removeWorkspaceWaiter(
    workspaceId: string,
    waiterToRemove: WorkspaceWaiter
  ): void {
    const waiters = this.workspaceWaiters.get(workspaceId);
    if (!waiters) return;
    const remaining = waiters.filter((waiter) => waiter !== waiterToRemove);
    if (remaining.length > 0) {
      this.workspaceWaiters.set(workspaceId, remaining);
    } else {
      this.workspaceWaiters.delete(workspaceId);
    }
  }
}
