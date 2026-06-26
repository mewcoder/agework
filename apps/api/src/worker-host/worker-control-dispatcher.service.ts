import { Injectable } from "@nestjs/common";
import { generateId } from "@agework/shared";
import type { ControlPayload, RunConfig } from "@agework/shared/protocol";
import { RuntimeConfigStore } from "./config-store";
import { WorkerAccessService } from "./access.service";
import { RuntimeControlQueue } from "./control-queue";
import { nextControlEnvelope } from "./control-envelope";

/**
 * worker 控制下发侧（local/sandbox 共用）：登记 runConfig、绑定 run 的 access key、
 * 维护 control seq 计数器，并把控制指令塞入 control queue。不持有 runtime 实例状态，
 * 所有入参均为原始值，便于在 worker-host 层独立存在。
 */
@Injectable()
export class WorkerControlDispatcher {
  private readonly controlSeqs = new Map<string, number>();
  private readonly cancelledStartingRuns = new Set<string>();

  constructor(
    private readonly runConfigStore: RuntimeConfigStore,
    private readonly runtimeAccess: WorkerAccessService,
    private readonly controlQueue: RuntimeControlQueue
  ) {}

  registerRunConfig(runId: string, runConfig: RunConfig): void {
    this.runConfigStore.register(runId, runConfig);
  }

  registerRunSession(params: {
    runId: string;
    scopeKey: string;
    accessKey: string;
    runConfig: RunConfig;
  }): void {
    this.runtimeAccess.registerRun(params.runId, params.accessKey);

    if (!this.controlSeqs.has(params.scopeKey)) {
      this.controlSeqs.set(params.scopeKey, 0);
    }

    this.sendControl(params.scopeKey, params.runId, {
      type: "user_message",
      commandId: generateId(),
      runId: params.runId,
      input: params.runConfig.input,
    });
  }

  sendControl(
    scopeKey: string,
    runId: string,
    control: ControlPayload
  ): void {
    const envelope = nextControlEnvelope(
      this.controlSeqs,
      scopeKey,
      runId,
      control
    );
    this.controlQueue.pushForWorkspace(scopeKey, envelope);
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

  cleanupWorkspace(scopeKey: string): void {
    this.controlQueue.cleanupWorkspace(scopeKey);
    this.controlSeqs.delete(scopeKey);
  }
}
