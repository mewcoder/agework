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
import { WorkerCommandDispatcher } from "../../../worker-host/worker-command-dispatcher.service";

@Injectable()
export class SandboxRuntimeProvider implements RuntimeProvider {
  readonly type = "sandbox" as const;
  private readonly logger = new Logger(SandboxRuntimeProvider.name);
  private receiver!: RunEventReceiver;

  constructor(
    private readonly runtimeInstances: SandboxRuntimeInstanceService,
    private readonly workerSessions: WorkerCommandDispatcher
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
    this.workerSessions.registerRunConfig(context.runId, context.runConfig);

    const handle = this.runtimeInstances.createRunHandle(context);
    const ownerState = this.runtimeInstances.ensureOwnerState(context);

    // provider 同时持有 resource 与 session，故由它写 ownerState 的 activeRuns，
    // dispatcher 不再触碰 sandbox 容器状态。
    ownerState.activeRuns.set(context.runId, context.runConfig.conversationId);
    this.workerSessions.registerRunSession({
      runId: context.runId,
      ownerId: context.ownerId,
      accessKey: ownerState.accessKey,
      runConfig: context.runConfig,
    });
    this.runtimeInstances.attachOrStartRuntimeInstance(
      {
        context,
        ownerState,
        handle,
        onRuntimeInstanceIdReady: input.onRuntimeInstanceIdReady,
      },
      this.runtimeInstanceCallbacks()
    );

    return handle;
  }

  sendCommand(handle: WorkerExecutionHandle, control: ControlPayload): void {
    const ownerId = this.runtimeInstances.findOwnerIdByRun(handle.runId);
    if (!ownerId) {
      this.logger.warn(
        `sandbox send command dropped ${safeLogJson({
          runId: handle.runId,
          controlType: control.type,
          reason: "no_owner",
        })}`
      );
      return;
    }
    this.workerSessions.sendCommand(ownerId, handle.runId, control);
  }

  cancel(handle: WorkerExecutionHandle): void {
    const ownerId = this.runtimeInstances.findOwnerIdByRun(handle.runId);
    const ownerState = ownerId
      ? this.runtimeInstances.getOwnerState(ownerId)
      : undefined;
    if (!ownerState?.runtimeInstanceId) {
      this.workerSessions.markCancelledBeforeReady(handle.runId);
      this.logger.debug(
        `sandbox cancel queued before ready ${safeLogJson({
          runId: handle.runId,
          ownerId,
        })}`
      );
      return;
    }
    this.sendCommand(handle, {
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

  heartbeatRuntimeInstance(ownerId: string): void {
    this.runtimeInstances.heartbeatRuntimeInstance(ownerId);
  }

  shutdownRuntimeInstance(ownerId: string): void {
    this.runtimeInstances.shutdownRuntimeInstance(ownerId, {
      cleanupByOwnerId: (key) => this.workerSessions.cleanupByOwnerId(key),
    });
  }

  recoverOrphan(runtimeInstanceId: string): Promise<void> {
    return this.runtimeInstances.recoverOrphan(runtimeInstanceId);
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
        ownerId: context.ownerId,
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
      cleanupByOwnerId: (ownerId) =>
        this.workerSessions.cleanupByOwnerId(ownerId),
    };
  }

  private forceCancelled(runId: string): void {
    if (this.receiver.isTerminalOrFinalizing(runId)) return;
    this.receiver
      .forceCancelledStatus(runId)
      .catch(swallow(this.logger, `force cancelled status for run ${runId}`));
  }
}
