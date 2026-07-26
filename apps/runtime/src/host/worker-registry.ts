import type {
  CommandPayload,
  RunChannelMessage,
} from "@agework/shared/protocol";
import { CommandMailbox } from "./command-mailbox";
import { HandshakeStore } from "./handshake-store";
import {
  WorkerPool,
  type WorkerEntry,
  type ReuseIdentity,
} from "./worker-pool";

/**
 * Worker 生命周期聚合：WorkerEntry、启动握手和命令信箱以 workerId 同生共死。
 *
 * WorkerPool / CommandMailbox / HandshakeStore 各自维护专门索引，本类是唯一组合
 * 入口，确保 RuntimeHost 不再跨三个状态容器手工清理。后续内部存储如何演进
 * 不影响 RuntimeHost 契约。
 */
export class WorkerRegistry {
  private readonly workers = new WorkerPool();
  private readonly mailbox = new CommandMailbox();
  private readonly handshakes = new HandshakeStore();

  put(entry: WorkerEntry): void {
    const identity: ReuseIdentity = {
      scope: entry.isolation.scope,
      subjectId: entry.isolation.subjectId,
      runtimeType: entry.runtimeType,
    };
    const previous = this.workers.getByIdentity(
      identity,
      entry.userLifecycleVersion
    );
    this.workers.put(entry);
    if (previous && previous.workerId !== entry.workerId) {
      this.cleanupControlState(previous.workerId, "worker superseded");
    }
  }

  /**
   * 原子移除 Worker 的全部 Host 内状态。未知 workerId 也清理残留的握手/信箱，
   * 让重复 stop/release 保持幂等。
   */
  evict(workerId: string, reason: string): WorkerEntry | undefined {
    const entry = this.workers.remove(workerId);
    this.cleanupControlState(workerId, reason);
    return entry;
  }

  waitForRegister(
    workerId: string,
    token: string
  ): Promise<{ pid?: number; registeredAt: string }> {
    return this.handshakes.waitForRegister(workerId, token);
  }

  cancelHandshake(workerId: string, reason: string): void {
    this.handshakes.cancel(workerId, reason);
  }

  registerWorker(
    workerId: string,
    token: string,
    info: { pid?: number }
  ): boolean {
    return this.handshakes.registerWorker(workerId, token, info);
  }

  enqueueCommand(
    workerId: string,
    runId: string,
    payload: CommandPayload
  ): RunChannelMessage<CommandPayload> {
    return this.mailbox.enqueue(workerId, runId, payload);
  }

  pollCommands(
    workerId: string,
    afterSeq: number,
    timeoutMs: number
  ): Promise<RunChannelMessage<CommandPayload>[]> {
    return this.mailbox.poll(workerId, afterSeq, timeoutMs);
  }

  commandEpoch(workerId: string): number {
    return this.mailbox.epochFor(workerId);
  }

  getById(...args: Parameters<WorkerPool["getById"]>) {
    return this.workers.getById(...args);
  }

  getByIdentity(...args: Parameters<WorkerPool["getByIdentity"]>) {
    return this.workers.getByIdentity(...args);
  }

  getByRunId(...args: Parameters<WorkerPool["getByRunId"]>) {
    return this.workers.getByRunId(...args);
  }

  ownsRun(...args: Parameters<WorkerPool["ownsRun"]>) {
    return this.workers.ownsRun(...args);
  }

  acquireOnce(...args: Parameters<WorkerPool["acquireOnce"]>) {
    return this.workers.acquireOnce(...args);
  }

  drainAcquisitions(...args: Parameters<WorkerPool["drainAcquisitions"]>) {
    return this.workers.drainAcquisitions(...args);
  }

  detachWorkspaceAcquisitions(
    ...args: Parameters<WorkerPool["detachWorkspaceAcquisitions"]>
  ) {
    return this.workers.detachWorkspaceAcquisitions(...args);
  }

  markReady(...args: Parameters<WorkerPool["markReady"]>): void {
    this.workers.markReady(...args);
  }

  associateRun(...args: Parameters<WorkerPool["associateRun"]>): void {
    this.workers.associateRun(...args);
  }

  dissociateRun(...args: Parameters<WorkerPool["dissociateRun"]>): void {
    this.workers.dissociateRun(...args);
  }

  touch(...args: Parameters<WorkerPool["touch"]>): void {
    this.workers.touch(...args);
  }

  markCancelled(...args: Parameters<WorkerPool["markCancelled"]>): void {
    this.workers.markCancelled(...args);
  }

  list(): WorkerEntry[] {
    return this.workers.list();
  }

  listByWorkspace(...args: Parameters<WorkerPool["listByWorkspace"]>) {
    return this.workers.listByWorkspace(...args);
  }

  listByUser(...args: Parameters<WorkerPool["listByUser"]>) {
    return this.workers.listByUser(...args);
  }

  drainControlPlane(): void {
    this.mailbox.drain();
  }

  private cleanupControlState(workerId: string, reason: string): void {
    this.handshakes.cancel(workerId, reason);
    this.mailbox.cleanup(workerId);
  }
}
