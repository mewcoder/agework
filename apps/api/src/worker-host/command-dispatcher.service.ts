import { Injectable } from "@nestjs/common";
import { generateId } from "@agework/shared";
import {
  nextCommandEnvelope,
  type CommandPayload,
  type RunConfig,
} from "@agework/shared/protocol";
import { WorkerConfigStore } from "./config-store";
import { WorkerAccessService } from "./access.service";
import { WorkerCommandQueue } from "./command-queue";

/**
 * worker command 下发侧（local/sandbox 共用）：登记 runConfig、绑定 run 的 access key、
 * 维护 command seq 计数器，并把命令塞入 command queue。不持有 runtime 实例状态，
 * 所有入参均为原始值，便于在 worker-host 层独立存在。
 *
 * 方法签名与 runtime 侧 CommandPort 结构兼容——由 run 层在启动时把本 dispatcher
 * 作为 CommandPort 注入给 sandbox provider，使 runtime 不直接依赖 worker-host。
 */
@Injectable()
export class WorkerCommandDispatcher {
  private readonly commandSeqs = new Map<string, number>();

  constructor(
    private readonly runConfigStore: WorkerConfigStore,
    private readonly runtimeAccess: WorkerAccessService,
    private readonly commandQueue: WorkerCommandQueue
  ) {}

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
      input: params.runConfig.input,
    });
  }

  sendCommand(ownerId: string, runId: string, command: CommandPayload): void {
    const envelope = nextCommandEnvelope(
      this.commandSeqs,
      ownerId,
      runId,
      command
    );
    this.commandQueue.pushByOwnerId(ownerId, envelope);
  }

  cleanupRun(runId: string): void {
    this.runConfigStore.unregister(runId);
    this.runtimeAccess.revokeAccess(runId);
  }

  cleanupByOwnerId(ownerId: string): void {
    this.commandQueue.cleanupByOwnerId(ownerId);
    this.commandSeqs.delete(ownerId);
  }
}

