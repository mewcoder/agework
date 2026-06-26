import { Injectable } from "@nestjs/common";
import { generateId } from "@agework/shared";
import type { ControlPayload, RunConfig } from "@agework/shared/protocol";
import { RuntimeConfigStore } from "./config-store";
import { WorkerAccessService } from "./access.service";
import { RuntimeCommandQueue } from "./command-queue";
import { nextCommandEnvelope } from "./command-envelope";

/**
 * worker command 下发侧（local/sandbox 共用）：登记 runConfig、绑定 run 的 access key、
 * 维护 command seq 计数器，并把命令塞入 command queue。不持有 runtime 实例状态，
 * 所有入参均为原始值，便于在 worker-host 层独立存在。
 */
@Injectable()
export class WorkerCommandDispatcher {
  private readonly commandSeqs = new Map<string, number>();
  private readonly cancelledStartingRuns = new Set<string>();

  constructor(
    private readonly runConfigStore: RuntimeConfigStore,
    private readonly runtimeAccess: WorkerAccessService,
    private readonly commandQueue: RuntimeCommandQueue
  ) {}

  registerRunConfig(runId: string, runConfig: RunConfig): void {
    this.runConfigStore.register(runId, runConfig);
  }

  registerRunSession(params: {
    runId: string;
    ownerId: string;
    accessKey: string;
    runConfig: RunConfig;
  }): void {
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

  sendCommand(
    ownerId: string,
    runId: string,
    control: ControlPayload
  ): void {
    const envelope = nextCommandEnvelope(
      this.commandSeqs,
      ownerId,
      runId,
      control
    );
    this.commandQueue.pushByOwnerId(ownerId, envelope);
  }

  markCancelledBeforeReady(runId: string): void {
    this.cancelledStartingRuns.add(runId);
  }

  consumeCancelledStartingRun(runId: string): boolean {
    return this.cancelledStartingRuns.delete(runId);
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
