import { Injectable } from "@nestjs/common";
import {
  nextCommandMessage,
  nextOwnerCommand,
  type CommandPayload,
  type RunConfig,
  type WorkspaceFileCommandPayload,
} from "@agework/shared/protocol";
import { WorkerConfigStore } from "./worker-config.store";
import { WorkerCommandQueue } from "./command-queue";

/**
 * worker command 下发侧（local/sandbox 共用）：登记 runConfig、
 * 维护 command seq 计数器，并把命令塞入 command queue。不持有 runtime 实例状态，
 * 所有入参均为原始值，便于在 worker-manager 层独立存在。
 *
 * 由 RunDriver 经 WorkerManagerService facade 调用；runtime 层只依赖
 * worker-manager facade，不直接依赖命令队列。
 */
@Injectable()
export class WorkerCommandDispatcher {
  private readonly commandSeqs = new Map<string, number>();
  private readonly fileCommandSeqs = new Map<string, number>();

  constructor(
    private readonly runConfigStore: WorkerConfigStore,
    private readonly commandQueue: WorkerCommandQueue
  ) {}

  /**
   * 打开一次 run 的会话：登记 runConfig。
   * 首个 user_message 由 run 侧 RunDriver 在 start 后显式下发，
   * worker-manager 不再代为生成命令，因此也不需要知道 run-event。
   */
  openSession(params: {
    runId: string;
    ownerId: string;
    runConfig: RunConfig;
  }): void {
    this.runConfigStore.register(params.runId, params.runConfig);
  }

  sendCommand(ownerId: string, runId: string, command: CommandPayload): void {
    const message = nextCommandMessage(
      this.commandSeqs,
      ownerId,
      runId,
      command
    );
    this.commandQueue.pushByOwnerId(ownerId, message);
  }

  /** 下发一条 owner-scoped 文件命令(无 runId,见 ADR-0004)。 */
  sendFileCommand(
    ownerId: string,
    payload: WorkspaceFileCommandPayload
  ): void {
    const command = nextOwnerCommand(
      this.fileCommandSeqs,
      ownerId,
      payload
    );
    this.commandQueue.pushFileCommand(ownerId, command);
  }

  cleanupRun(runId: string): void {
    this.runConfigStore.unregister(runId);
  }

  cleanupByOwnerId(ownerId: string): void {
    this.commandQueue.cleanupByOwnerId(ownerId);
    this.commandSeqs.delete(ownerId);
    this.fileCommandSeqs.delete(ownerId);
  }
}
