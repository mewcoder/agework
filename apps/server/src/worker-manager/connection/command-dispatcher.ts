import { Injectable } from "@nestjs/common";
import {
  nextCommandMessage,
  type CommandPayload,
  type RunConfig,
} from "@agework/shared/protocol";
import { WorkerConfigStore } from "./worker-config.store";
import { WorkerCommandQueue } from "./command-queue";

/**
 * worker command 下发侧（native/sandbox 共用）：登记 runConfig、
 * 维护 command seq 计数器，并把命令塞入 command queue。不持有 runtime 实例状态，
 * 所有入参均为原始值，便于在 worker-manager 层独立存在。
 *
 * 由 RunDriver 经 WorkerManagerService facade 调用；runtime 层只依赖
 * worker-manager facade，不直接依赖命令队列。
 */
@Injectable()
export class WorkerCommandDispatcher {
  private readonly commandSeqs = new Map<string, number>();

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
    workerId: string;
    runConfig: RunConfig;
  }): void {
    this.runConfigStore.register(params.runId, params.runConfig);
  }

  sendCommand(workerId: string, runId: string, command: CommandPayload): void {
    const message = nextCommandMessage(
      this.commandSeqs,
      workerId,
      runId,
      command
    );
    this.commandQueue.pushByWorkerId(workerId, message);
  }

  cleanupRun(runId: string): void {
    this.runConfigStore.unregister(runId);
  }

  cleanupByWorkerId(workerId: string): void {
    this.commandQueue.cleanupByWorkerId(workerId);
    this.commandSeqs.delete(workerId);
  }
}
