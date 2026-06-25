import { Injectable } from "@nestjs/common";
import { generateId } from "@agework/shared";
import type { ControlPayload } from "@agework/shared/protocol";
import { RuntimeConfigStore } from "../internal/runtime-config-store";
import { RuntimeInternalAccessService } from "../internal/runtime-internal-access.service";
import { RuntimeControlQueue } from "../internal/runtime-control-queue";
import { nextControlEnvelope } from "./runtime-provider-utils";
import type {
  SandboxScopeState,
  SandboxWorkerExecutionContext,
} from "./sandbox-runtime-resource.service";

@Injectable()
export class SandboxWorkerSessionService {
  private readonly controlSeqs = new Map<string, number>();
  private readonly cancelledStartingRuns = new Set<string>();

  constructor(
    private readonly runConfigStore: RuntimeConfigStore,
    private readonly runtimeAccess: RuntimeInternalAccessService,
    private readonly controlQueue: RuntimeControlQueue
  ) {}

  registerRunConfig(context: SandboxWorkerExecutionContext): void {
    this.runConfigStore.register(context.runId, context.runConfig);
  }

  registerRunSession(
    context: SandboxWorkerExecutionContext,
    scopeState: SandboxScopeState
  ): void {
    this.runtimeAccess.registerRun(context.runId, scopeState.accessKey);
    scopeState.activeRuns.set(
      context.runId,
      context.runConfig.conversationId
    );

    if (!this.controlSeqs.has(context.resourceKey)) {
      this.controlSeqs.set(context.resourceKey, 0);
    }

    this.sendControl(context.resourceKey, context.runId, {
      type: "user_message",
      commandId: generateId(),
      runId: context.runId,
      input: context.runConfig.input,
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
    this.controlQueue.cleanup(runId);
    this.runtimeAccess.revokeAccess(runId);
  }

  cleanupWorkspace(resourceKey: string): void {
    this.controlQueue.cleanupWorkspace(resourceKey);
    this.controlSeqs.delete(resourceKey);
  }
}
