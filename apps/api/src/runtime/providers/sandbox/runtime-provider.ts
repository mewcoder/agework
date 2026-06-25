import { Injectable, Logger } from "@nestjs/common";
import { generateId } from "@agework/shared";
import type {
  WorkerExecutionHandle,
  WorkerExecutionStartInput,
  ControlPayload,
} from "@agework/shared/protocol";
import { swallow } from "../../../common/swallow";
import { safeLogJson } from "../../../common/logging";
import { publishWorkerErrorStatus } from "../provider-utils";
import type { RunEventReceiver } from "../run-event-receiver";
import type { RuntimeProvider } from "../provider-contracts";
import {
  SandboxRuntimeInstanceService,
  type SandboxRuntimeInstanceCallbacks,
  type SandboxWorkerExecutionContext,
} from "./runtime-instance.service";
import { SandboxWorkerSessionService } from "./worker-session.service";

@Injectable()
export class SandboxRuntimeProvider implements RuntimeProvider {
  readonly type = "sandbox" as const;
  private readonly logger = new Logger(SandboxRuntimeProvider.name);
  private receiver!: RunEventReceiver;

  constructor(
    private readonly runtimeInstances: SandboxRuntimeInstanceService,
    private readonly workerSessions: SandboxWorkerSessionService
  ) {}

  setRunEventReceiver(receiver: RunEventReceiver): void {
    this.receiver = receiver;
  }

  startWorkerExecution(
    input: WorkerExecutionStartInput
  ): WorkerExecutionHandle {
    if (input.runtimeTarget.runtimeType !== this.type) {
      throw new Error(
        `SandboxRuntimeProvider cannot start worker for runtime type: ${input.runtimeTarget.runtimeType}`
      );
    }

    const context =
      this.runtimeInstances.resolveWorkerExecutionContext(input);
    this.logWorkerExecutionStart(context);
    this.workerSessions.registerRunConfig(context);

    const handle = this.runtimeInstances.createRunHandle(context);
    const scopeState = this.runtimeInstances.ensureScopeState(context);

    this.workerSessions.registerRunSession(context, scopeState);
    this.runtimeInstances.attachOrStartRuntimeInstance(
      {
        context,
        scopeState,
        handle,
        onRuntimeResourceIdReady: input.onRuntimeResourceIdReady,
      },
      this.runtimeInstanceCallbacks()
    );

    return handle;
  }

  sendControl(handle: WorkerExecutionHandle, control: ControlPayload): void {
    const scopeKey = this.runtimeInstances.findScopeKeyByRun(handle.runId);
    if (!scopeKey) {
      this.logger.warn(
        `sandbox send control dropped ${safeLogJson({
          runId: handle.runId,
          controlType: control.type,
          reason: "no_scope",
        })}`
      );
      return;
    }
    this.workerSessions.sendControl(scopeKey, handle.runId, control);
  }

  cancel(handle: WorkerExecutionHandle): void {
    const scopeKey = this.runtimeInstances.findScopeKeyByRun(handle.runId);
    const scopeState = scopeKey
      ? this.runtimeInstances.getScopeState(scopeKey)
      : undefined;
    if (!scopeState?.runtimeResourceId) {
      this.workerSessions.markCancelledBeforeReady(handle.runId);
      this.logger.debug(
        `sandbox cancel queued before ready ${safeLogJson({
          runId: handle.runId,
          scopeKey,
        })}`
      );
      return;
    }
    this.sendControl(handle, {
      type: "cancel",
      commandId: generateId(),
      runId: handle.runId,
      conversationId: handle.conversationId,
    });
  }

  getHandle(runId: string): WorkerExecutionHandle | undefined {
    return this.runtimeInstances.getHandle(runId);
  }

  heartbeat(runId: string): void {
    this.runtimeInstances.heartbeatRun(runId);
  }

  heartbeatRuntimeInstance(resourceKey: string): void {
    this.runtimeInstances.heartbeatRuntimeInstance(resourceKey);
  }

  shutdownRuntimeInstance(resourceKey: string): void {
    this.runtimeInstances.shutdownRuntimeInstance(resourceKey, {
      cleanupWorkspace: (key) => this.workerSessions.cleanupWorkspace(key),
    });
  }

  recoverOrphan(runtimeResourceId: string): Promise<void> {
    return this.runtimeInstances.recoverOrphan(runtimeResourceId);
  }

  cleanup(runId: string): void {
    this.runtimeInstances.cleanupRun(runId);
    this.workerSessions.cleanupRun(runId);
  }

  private logWorkerExecutionStart(
    context: SandboxWorkerExecutionContext
  ): void {
    this.logger.log(
      `sandbox run starting ${safeLogJson({
        runId: context.runId,
        conversationId: context.runConfig.conversationId,
        workspaceId: context.workspaceId,
        resourceKey: context.resourceKey,
        isolationScope: context.isolationScope,
        engineType: context.engineType,
      })}`
    );
  }

  private runtimeInstanceCallbacks(): SandboxRuntimeInstanceCallbacks {
    return {
      consumeCancelledStartingRun: (runId) =>
        this.workerSessions.consumeCancelledStartingRun(runId),
      forceCancelled: (runId) => this.forceCancelled(runId),
      publishWorkerError: (runId, error) =>
        publishWorkerErrorStatus(this.receiver, runId, error),
      cleanupWorkspace: (resourceKey) =>
        this.workerSessions.cleanupWorkspace(resourceKey),
    };
  }

  private forceCancelled(runId: string): void {
    if (this.receiver.isTerminalOrFinalizing(runId)) return;
    this.receiver
      .forceCancelledStatus(runId)
      .catch(swallow(this.logger, `force cancelled status for run ${runId}`));
  }
}
