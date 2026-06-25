import { Injectable, Logger } from "@nestjs/common";
import { generateId } from "@agework/shared";
import type {
  RuntimePlacement,
  RuntimeResourceHandle,
  WorkerExecutionHandle,
  ControlPayload,
} from "@agework/shared/protocol";
import { swallow } from "../../common/swallow";
import { safeLogJson } from "../../common/logging";
import { runtimeResourceHandleFromPlacement } from "../core/runtime-resources/runtime-resource-handle";
import { publishWorkerErrorStatus } from "./runtime-provider-utils";
import type { RunEventReceiver } from "../run-event-receiver";
import type {
  ProviderWorkerExecutionStartInput,
  RuntimeProvider,
  RuntimeResourceProvider,
  WorkerExecutionProvider,
} from "./runtime-provider-contracts";
import {
  SandboxRuntimeResourceService,
  type SandboxRuntimeResourceCallbacks,
  type SandboxWorkerExecutionContext,
} from "./sandbox-runtime-resource.service";
import { SandboxWorkerSessionService } from "./sandbox-worker-session.service";

@Injectable()
export class SandboxRuntimeProvider
  implements RuntimeProvider, RuntimeResourceProvider, WorkerExecutionProvider
{
  readonly type = "sandbox" as const;
  private readonly logger = new Logger(SandboxRuntimeProvider.name);
  private receiver!: RunEventReceiver;

  constructor(
    private readonly runtimeResources: SandboxRuntimeResourceService,
    private readonly workerSessions: SandboxWorkerSessionService
  ) {}

  setRunEventReceiver(receiver: RunEventReceiver): void {
    this.receiver = receiver;
  }

  provision(placement: RuntimePlacement): RuntimeResourceHandle {
    return runtimeResourceHandleFromPlacement(placement);
  }

  startWorkerExecution(
    input: ProviderWorkerExecutionStartInput
  ): WorkerExecutionHandle {
    if (input.runtimeResource.runtimeType !== this.type) {
      throw new Error(
        `SandboxRuntimeProvider cannot start worker for runtime type: ${input.runtimeResource.runtimeType}`
      );
    }

    const context =
      this.runtimeResources.resolveWorkerExecutionContext(input);
    this.logWorkerExecutionStart(context);
    this.workerSessions.registerRunConfig(context);

    const handle = this.runtimeResources.createRunHandle(context);
    const scopeState = this.runtimeResources.ensureScopeState(context);

    this.workerSessions.registerRunSession(context, scopeState);
    this.runtimeResources.attachOrStartRuntimeResource(
      {
        context,
        scopeState,
        handle,
        onRuntimeResourceIdReady: input.onRuntimeResourceIdReady,
      },
      this.runtimeResourceCallbacks()
    );

    return handle;
  }

  sendControl(handle: WorkerExecutionHandle, control: ControlPayload): void {
    const scopeKey = this.runtimeResources.findScopeKeyByRun(handle.runId);
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
    const scopeKey = this.runtimeResources.findScopeKeyByRun(handle.runId);
    const scopeState = scopeKey
      ? this.runtimeResources.getScopeState(scopeKey)
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
    return this.runtimeResources.getHandle(runId);
  }

  heartbeat(runId: string): void {
    this.runtimeResources.heartbeatRun(runId);
  }

  heartbeatRuntimeResource(resourceKey: string): void {
    this.runtimeResources.heartbeatRuntimeResource(resourceKey);
  }

  shutdownRuntimeResource(resourceKey: string): void {
    this.runtimeResources.shutdownRuntimeResource(resourceKey, {
      cleanupWorkspace: (key) => this.workerSessions.cleanupWorkspace(key),
    });
  }

  recoverOrphan(runtimeResourceId: string): Promise<void> {
    return this.runtimeResources.recoverOrphan(runtimeResourceId);
  }

  cleanup(runId: string): void {
    this.runtimeResources.cleanupRun(runId);
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

  private runtimeResourceCallbacks(): SandboxRuntimeResourceCallbacks {
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
