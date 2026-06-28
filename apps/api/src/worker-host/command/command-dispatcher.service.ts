import { Injectable } from "@nestjs/common";
import { generateId } from "@agework/shared";
import {
  nextCommandMessage,
  type CommandPayload,
  type RunConfig,
} from "@agework/shared/protocol";
import { WorkerConfigStore } from "../config/config-store";
import { WorkerAccessService } from "../access/access.service";
import { WorkerCommandQueue } from "./command-queue";
import type { CommandSentRecorder } from "./command-sent-recorder.port";

/**
 * worker command 下发侧（local/sandbox 共用）：登记 runConfig、绑定 run 的 access key、
 * 维护 command seq 计数器，并把命令塞入 command queue。不持有 runtime 实例状态，
 * 所有入参均为原始值，便于在 worker-host 层独立存在。
 *
 * 由 SandboxRunExecutor 经 WorkerHostService facade 调用；runtime 层只依赖
 * worker-host facade，不直接依赖命令队列，也不负责签发或撤销 worker access key。
 */
@Injectable()
export class WorkerCommandDispatcher {
  private readonly commandSeqs = new Map<string, number>();

  constructor(
    private readonly runConfigStore: WorkerConfigStore,
    private readonly runtimeAccess: WorkerAccessService,
    private readonly commandQueue: WorkerCommandQueue
  ) {}

  /**
   * 注入命令下发 trace 记录端口（由 run 层在启动时提供实现）。
   * 经此转发到内部 command queue，使 run 层无需直接依赖内部队列。
   */
  setCommandSentRecorder(recorder: CommandSentRecorder): void {
    this.commandQueue.setCommandSentRecorder(recorder);
  }

  openSession(params: {
    runId: string;
    ownerId: string;
    accessKey: string;
    runConfig: RunConfig;
  }): void {
    this.runConfigStore.register(params.runId, params.runConfig);
    this.runtimeAccess.registerRun(params.runId, params.accessKey);

    if (!this.commandSeqs.has(params.ownerId)) {
      this.commandSeqs.set(params.ownerId, 0);
    }

    this.sendCommand(params.ownerId, params.runId, {
      type: "user_message",
      commandId: generateId(),
      runId: params.runId,
    });
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

  cleanupRun(runId: string): void {
    this.runConfigStore.unregister(runId);
    this.runtimeAccess.revokeAccess(runId);
  }

  cleanupByOwnerId(ownerId: string): void {
    this.commandQueue.cleanupByOwnerId(ownerId);
    this.commandSeqs.delete(ownerId);
    this.runtimeAccess.revokeOwner(ownerId);
  }
}
