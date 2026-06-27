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

type SandboxRunState = {
  handle: WorkerExecutionHandle;
  ownerId: string;
  cancelledBeforeReady: boolean;
  onRuntimeInstanceIdReady?: (runtimeInstanceId: string) => void;
};

@Injectable()
export class SandboxRunExecutor implements RunExecutor {
  readonly type = "sandbox" as const;
  private readonly logger = new Logger(SandboxRunExecutor.name);
  private readonly states = new Map<string, SandboxRunState>();
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

    const handle = this.createRunHandle(context);
    const ownerState = this.runtimeInstances.ensureOwnerState(context, {
      issueOwnerAccessKey: (ownerId) =>
        this.access.issueOwnerKey(ownerId),
    });

    // Run executor 负责把 run 绑定到 runtime owner，并打开 worker-host session。
    this.states.set(context.runId, {
      handle,
      ownerId: context.ownerId,
      cancelledBeforeReady: false,
      onRuntimeInstanceIdReady: input.onRuntimeInstanceIdReady,
    });
    this.runtimeInstances.retainOwnerRun(context.ownerId);
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
      },
      this.runtimeInstanceCallbacks()
    );

    return handle;
  }

  sendCommand(handle: WorkerExecutionHandle, command: CommandPayload): void {
    const state = this.states.get(handle.runId);
    if (!state) {
      this.logger.warn(
        `sandbox send command dropped ${safeLogJson({
          runId: handle.runId,
          commandType: command.type,
          reason: "no_owner",
        })}`
      );
      return;
    }
    this.commands.sendCommand(state.ownerId, handle.runId, command);
  }

  cancel(handle: WorkerExecutionHandle): void {
    const state = this.states.get(handle.runId);
    const ownerState = state
      ? this.runtimeInstances.getOwnerState(state.ownerId)
      : undefined;
    if (!ownerState?.runtimeInstanceId) {
      if (state) state.cancelledBeforeReady = true;
      this.logger.debug(
        `sandbox cancel queued before ready ${safeLogJson({
          runId: handle.runId,
          ownerId: state?.ownerId,
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
    return this.states.get(runId)?.handle;
  }

  recoverOrphanExecution(runtimeInstanceId: string): Promise<void> {
    return this.runtimeInstances.recoverOrphan(runtimeInstanceId);
  }

  terminateExecution(runId: string): void {
    this.cleanup(runId);
  }

  cleanup(runId: string): void {
    const state = this.states.get(runId);
    if (state) {
      this.states.delete(runId);
      this.runtimeInstances.releaseOwnerRun(state.ownerId);
    }
    this.commands.cleanupRun(runId);
  }

  private createRunHandle(
    context: SandboxWorkerExecutionContext
  ): WorkerExecutionHandle {
    return {
      runId: context.runId,
      runtimeType: context.runtimeTarget.runtimeType,
      runtimeInstanceId: "",
      conversationId: context.runConfig.conversationId,
    };
  }

  private markRuntimeReady(runId: string, runtimeInstanceId: string): void {
    const state = this.states.get(runId);
    if (!state) return;
    if (state.cancelledBeforeReady) {
      this.cleanup(runId);
      this.receiver
        .notifyCancelledBeforeReady(runId)
        .catch(
          swallow(
            this.logger,
            `notify cancelled before ready for run ${runId}`
          )
        );
      return;
    }

    state.handle.runtimeInstanceId = runtimeInstanceId;
    state.onRuntimeInstanceIdReady?.(runtimeInstanceId);
  }

  private cleanupByOwnerId(ownerId: string): void {
    for (const [runId, state] of this.states) {
      if (state.ownerId !== ownerId) continue;
      this.states.delete(runId);
    }
    this.commands.cleanupByOwnerId(ownerId);
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
      runtimeReady: (runId, runtimeInstanceId) =>
        this.markRuntimeReady(runId, runtimeInstanceId),
      publishWorkerError: (runId, error) =>
        this.receiver
          .notifyWorkerError(runId, error)
          .catch(swallow(this.logger, `notify worker error for run ${runId}`)),
      cleanupByOwnerId: (ownerId) =>
        this.cleanupByOwnerId(ownerId),
      registerRuntimeInstanceAccess: (runtimeInstanceId, ownerId) =>
        this.access.issueRuntimeInstanceKey(runtimeInstanceId, ownerId),
    };
  }
}
