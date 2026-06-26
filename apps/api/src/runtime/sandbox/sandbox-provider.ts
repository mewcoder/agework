import { Injectable, Logger } from "@nestjs/common";
import { generateId } from "@agework/shared";
import type {
  WorkerExecutionHandle,
  WorkerExecutionStartInput,
  CommandPayload,
} from "@agework/shared/protocol";
import { swallow } from "../../common/swallow";
import { safeLogJson } from "../../common/logging";
import type { RunEventReceiver } from "../providers/run-event-receiver.port";
import type { CommandPort } from "../providers/command-port";
import type { AccessPort } from "../providers/access-port";
import type {
  WorkerExecutionProvider,
  RuntimeInstanceManager,
} from "../providers/provider-contracts";
import {
  SandboxRuntimeInstanceService,
  type SandboxRuntimeInstanceCallbacks,
  type SandboxWorkerExecutionContext,
} from "./sandbox-instance.service";

@Injectable()
export class SandboxRuntimeProvider
  implements WorkerExecutionProvider, RuntimeInstanceManager
{
  readonly type = "sandbox" as const;
  private readonly logger = new Logger(SandboxRuntimeProvider.name);
  private receiver!: RunEventReceiver;
  private commands!: CommandPort;

  constructor(
    private readonly runtimeInstances: SandboxRuntimeInstanceService
  ) {}

  setRunEventReceiver(receiver: RunEventReceiver): void {
    this.receiver = receiver;
  }

  /** 由 run 层注入命令通道（worker-host 的 dispatcher），使 runtime 不直接依赖 worker-host。 */
  setCommandPort(commands: CommandPort): void {
    this.commands = commands;
  }

  /** 由 run 层注入鉴权通道（worker-host 的 access service），转发给 instance service。 */
  setAccessPort(access: AccessPort): void {
    this.runtimeInstances.setAccessPort(access);
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

    const handle = this.runtimeInstances.createRunHandle(context);
    const ownerState = this.runtimeInstances.ensureOwnerState(context);

    // provider 同时持有 resource 与 session，故由它写 ownerState 的 activeRuns，
    // dispatcher 不再触碰 sandbox 容器状态。
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

  shutdownRuntimeInstance(ownerId: string): void {
    this.runtimeInstances.shutdownRuntimeInstance(ownerId, {
      cleanupByOwnerId: (key) => this.commands.cleanupByOwnerId(key),
    });
  }

  recoverOrphan(runtimeInstanceId: string): Promise<void> {
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
    };
  }
}
