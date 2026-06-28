import { Injectable, Logger } from "@nestjs/common";
import { generateId } from "@agework/shared";
import type {
  WorkerExecutionHandle,
  WorkerExecutionStartInput,
  CommandPayload,
} from "@agework/shared/protocol";
import { swallow } from "../../common/swallow";
import { safeLogJson } from "../../common/logging";
import { WorkerHostService } from "../../worker-host/worker-host.service";
import {
  SandboxRuntimeInstanceService,
  type SandboxRuntimeInstanceCallbacks,
  type SandboxWorkerExecutionContext,
} from "./sandbox-instance.service";

/**
 * sandbox 执行回流端口：执行过程中的异常事实通过它通知 run 层。
 * 由 run 在启动期经 RuntimeService.setSandboxWorkerEventSink 注入实现，
 * 避免 runtime 反向依赖 run（结构上由 run 的 RunEventReceiver 满足）。
 */
export interface SandboxWorkerEventSink {
  notifyWorkerError(runId: string, error: string): Promise<void>;
  notifyCancelledBeforeReady(runId: string): Promise<void>;
}

type SandboxRunState = {
  handle: WorkerExecutionHandle;
  ownerId: string;
  cancelledBeforeReady: boolean;
  onRuntimeInstanceIdReady?: (runtimeInstanceId: string) => void;
};

/**
 * sandbox per-run 执行编排（runtime 内部 provider）：把一次 run 绑定到 sandbox
 * runtime owner，打开 worker-host session，并驱动 runtime 实例的 attach/start/cleanup。
 * 由 RuntimeService 经 startSandboxWorker / cancelSandboxRun 等门面暴露给 run；
 * run 层不直接依赖本 provider 或 SandboxRuntimeInstanceService。
 */
@Injectable()
export class SandboxWorkerExecutor {
  private readonly type = "sandbox" as const;
  private readonly logger = new Logger(SandboxWorkerExecutor.name);
  private readonly states = new Map<string, SandboxRunState>();
  private sink!: SandboxWorkerEventSink;

  constructor(
    private readonly runtimeInstances: SandboxRuntimeInstanceService,
    private readonly workerHost: WorkerHostService
  ) {}

  setEventSink(sink: SandboxWorkerEventSink): void {
    this.sink = sink;
  }

  start(input: WorkerExecutionStartInput): WorkerExecutionHandle {
    if (input.runtimeTarget.runtimeType !== this.type) {
      throw new Error(
        `SandboxWorkerExecutor cannot start worker for runtime type: ${input.runtimeTarget.runtimeType}`
      );
    }

    const context = this.runtimeInstances.resolveWorkerExecutionContext(input);
    this.logWorkerExecutionStart(context);

    const handle = this.createRunHandle(context);
    const ownerState = this.runtimeInstances.ensureOwnerState(context, {
      issueOwnerAccessKey: (ownerId) => this.workerHost.issueOwnerKey(ownerId),
    });

    // Run executor 负责把 run 绑定到 runtime owner，并打开 worker-host session。
    this.states.set(context.runId, {
      handle,
      ownerId: context.ownerId,
      cancelledBeforeReady: false,
      onRuntimeInstanceIdReady: input.onRuntimeInstanceIdReady,
    });
    this.runtimeInstances.retainOwnerRun(context.ownerId);
    this.workerHost.openSession({
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
    this.workerHost.sendCommand(state.ownerId, handle.runId, command);
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

  cleanupInterruptedExecution(runtimeInstanceId: string): Promise<void> {
    return this.runtimeInstances.recoverOrphan(runtimeInstanceId);
  }

  terminateExecution(runId: string, reason: string): void {
    this.logger.warn(
      `terminating sandbox run session ${safeLogJson({ runId, reason })}`
    );
    this.cleanup(runId);
  }

  cleanup(runId: string): void {
    const state = this.states.get(runId);
    if (state) {
      this.states.delete(runId);
      this.runtimeInstances.releaseOwnerRun(state.ownerId);
    }
    this.workerHost.cleanupRun(runId);
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
      this.sink
        .notifyCancelledBeforeReady(runId)
        .catch(
          swallow(this.logger, `notify cancelled before ready for run ${runId}`)
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
    this.workerHost.cleanupByOwnerId(ownerId);
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
        this.sink
          .notifyWorkerError(runId, error)
          .catch(swallow(this.logger, `notify worker error for run ${runId}`)),
      cleanupByOwnerId: (ownerId) => this.cleanupByOwnerId(ownerId),
    };
  }
}
