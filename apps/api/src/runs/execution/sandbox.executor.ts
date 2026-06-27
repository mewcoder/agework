import { Injectable, Logger } from "@nestjs/common";
import { generateId } from "@agework/shared";
import type {
  WorkerExecutionHandle,
  WorkerExecutionStartInput,
  CommandPayload,
} from "@agework/shared/protocol";
import { swallow } from "../../common/swallow";
import { safeLogJson } from "../../common/logging";
import type {
  RunEventReceiver,
  RunExecutor,
} from "./executor";
import { WorkerCommandDispatcher } from "../../worker-host/command-dispatcher.service";
import { WorkerAccessService } from "../../worker-host/access.service";
import {
  SandboxRuntimeInstanceService,
  type SandboxRuntimeInstanceCallbacks,
  type SandboxWorkerExecutionContext,
} from "../../runtime/sandbox/sandbox-instance.service";

@Injectable()
export class SandboxRunExecutor implements RunExecutor {
  readonly type = "sandbox" as const;
  private readonly logger = new Logger(SandboxRunExecutor.name);
  private receiver!: RunEventReceiver;

  constructor(
    private readonly runtimeInstances: SandboxRuntimeInstanceService,
    private readonly commands: WorkerCommandDispatcher,
    private readonly access: WorkerAccessService
  ) {}

  setRunEventReceiver(receiver: RunEventReceiver): void {
    this.receiver = receiver;
  }

  start(input: WorkerExecutionStartInput): WorkerExecutionHandle {
    if (input.runtimeTarget.runtimeType !== this.type) {
      throw new Error(
        `SandboxRunExecutor cannot start worker for runtime type: ${input.runtimeTarget.runtimeType}`
      );
    }

    const context =
      this.runtimeInstances.resolveWorkerExecutionContext(input);
    this.logWorkerExecutionStart(context);

    const handle = this.runtimeInstances.createRunHandle(context);
    const ownerState = this.runtimeInstances.ensureOwnerState(context, {
      issueOwnerAccessKey: (ownerId) =>
        this.access.issueOwnerKey(ownerId),
    });

    // Run executor 负责把 run 绑定到 runtime owner，并打开 worker-host session。
    ownerState.activeRuns.set(context.runId, context.runConfig.conversationId);
    this.commands.openSession({
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

  sendCommand(handle: WorkerExecutionHandle, command: CommandPayload): void {
    const ownerId = this.runtimeInstances.findOwnerIdByRun(handle.runId);
    if (!ownerId) {
      this.logger.warn(
        `sandbox send command dropped ${safeLogJson({
          runId: handle.runId,
          commandType: command.type,
          reason: "no_owner",
        })}`
      );
      return;
    }
    this.commands.sendCommand(ownerId, handle.runId, command);
  }

  cancel(handle: WorkerExecutionHandle): void {
    const ownerId = this.runtimeInstances.findOwnerIdByRun(handle.runId);
    const ownerState = ownerId
      ? this.runtimeInstances.getOwnerState(ownerId)
      : undefined;
    if (!ownerState?.runtimeInstanceId) {
      this.runtimeInstances.markCancelledBeforeReady(handle.runId);
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

  recoverOrphanExecution(runtimeInstanceId: string): Promise<void> {
    return this.runtimeInstances.recoverOrphan(runtimeInstanceId);
  }

  terminateExecution(runId: string): void {
    this.cleanup(runId);
  }

  cleanup(runId: string): void {
    this.runtimeInstances.cleanupRun(runId);
    this.commands.cleanupRun(runId);
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
      forceCancelled: (runId) =>
        this.receiver
          .notifyCancelledBeforeReady(runId)
          .catch(swallow(this.logger, `notify cancelled before ready for run ${runId}`)),
      publishWorkerError: (runId, error) =>
        this.receiver
          .notifyWorkerError(runId, error)
          .catch(swallow(this.logger, `notify worker error for run ${runId}`)),
      cleanupByOwnerId: (ownerId) =>
        this.commands.cleanupByOwnerId(ownerId),
      registerRuntimeInstanceAccess: (runtimeInstanceId, ownerId) =>
        this.access.issueRuntimeInstanceKey(runtimeInstanceId, ownerId),
    };
  }
}
