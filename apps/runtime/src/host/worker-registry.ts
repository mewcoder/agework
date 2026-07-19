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
export class WorkerRegistry extends WorkerPool {
  private readonly mailbox = new CommandMailbox();
  private readonly handshakes = new HandshakeStore();

  override put(entry: WorkerEntry): void {
    const identity: ReuseIdentity = {
      scope: entry.isolation.scope,
      subjectId: entry.isolation.subjectId,
      runtimeType: entry.runtimeType,
    };
    const previous = this.getByIdentity(
      identity,
      entry.userLifecycleVersion
    );
    super.put(entry);
    if (previous && previous.workerId !== entry.workerId) {
      this.cleanupControlState(previous.workerId, "worker superseded");
    }
  }

  /**
   * 原子移除 Worker 的全部 Host 内状态。未知 workerId 也清理残留的握手/信箱，
   * 让重复 stop/release 保持幂等。
   */
  evict(workerId: string, reason: string): WorkerEntry | undefined {
    const entry = super.remove(workerId);
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

  drainControlPlane(): void {
    this.mailbox.drain();
  }

  private cleanupControlState(workerId: string, reason: string): void {
    this.handshakes.cancel(workerId, reason);
    this.mailbox.cleanup(workerId);
  }
}
