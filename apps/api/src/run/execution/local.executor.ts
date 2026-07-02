import { Injectable, Logger } from "@nestjs/common";
import { generateId } from "@agework/shared";
import type {
  AcquireInstanceResult,
  WorkerExecutionHandle,
  WorkerExecutionStartInput,
  CommandPayload,
} from "@agework/shared/protocol";
import type { RunEventPort, RunExecutor } from "./executor";
import { WorkerHostService } from "../../worker-host/worker-host.service";
import { errorLogFields, safeLogJson } from "../../common/logging";
import { swallow } from "../../common/swallow";

type LocalRunState = {
  handle: WorkerExecutionHandle;
  ownerId: string;
  status: "acquiring" | "ready";
  cancelled: boolean;
};

/**
 * local run executor:owner 长期复用一个 keep-alive 进程(worker-host 的
 * LocalInstanceExecutor 负责),per-run 执行编排归 run 层——跟 SandboxRunExecutor
 * 同构,不再自己 fork/持有 IPC channel(那是 Phase 2 之前的旧模型,已废弃)。
 */
@Injectable()
export class LocalRunExecutor implements RunExecutor {
  readonly type = "local" as const;
  private readonly logger = new Logger(LocalRunExecutor.name);
  private readonly states = new Map<string, LocalRunState>();
  private receiver!: RunEventPort;

  constructor(private readonly workerHost: WorkerHostService) {}

  setRunEventPort(receiver: RunEventPort): void {
    this.receiver = receiver;
  }

  start(input: WorkerExecutionStartInput): WorkerExecutionHandle {
    const { runConfig, runtimeTarget } = input;
    const handle: WorkerExecutionHandle = {
      runId: runConfig.runId,
      runtimeType: runtimeTarget.runtimeType,
      runtimeInstanceId: "",
      conversationId: runConfig.conversationId,
    };
    this.states.set(runConfig.runId, {
      handle,
      ownerId: runtimeTarget.ownerId,
      status: "acquiring",
      cancelled: false,
    });

    try {
      this.workerHost
        .acquireLocalInstanceForRun(input)
        .then((result) => this.onAcquired(input, result))
        .catch((err) => this.onAcquireFailed(runConfig.runId, err));
    } catch (err) {
      this.onAcquireFailed(runConfig.runId, err);
    }

    return handle;
  }

  private onAcquired(
    input: WorkerExecutionStartInput,
    result: AcquireInstanceResult
  ): void {
    const { runId } = input.runConfig;
    const state = this.states.get(runId);
    if (!state) return;

    if (result.outcome === "error") {
      this.states.delete(runId);
      this.notifyWorkerError(runId, result.error);
      return;
    }
    if (result.outcome === "cancelledBeforeReady") {
      this.states.delete(runId);
      this.notifyCancelledBeforeReady(runId);
      return;
    }

    if (state.cancelled) {
      this.states.delete(runId);
      this.notifyCancelledBeforeReady(runId);
      return;
    }

    state.handle.runtimeInstanceId = result.runtimeInstanceId;
    state.status = "ready";
    input.onRuntimeInstanceIdReady?.(result.runtimeInstanceId);

    this.workerHost.openSession({
      runId,
      ownerId: state.ownerId,
      runConfig: input.runConfig,
    });
    this.sendCommand(state.handle, {
      type: "user_message",
      commandId: generateId(),
      runId,
    });
  }

  sendCommand(handle: WorkerExecutionHandle, command: CommandPayload): void {
    const state = this.states.get(handle.runId);
    if (!state) {
      this.logger.warn(
        `local send command dropped ${safeLogJson({
          runId: handle.runId,
          commandType: command.type,
          reason: "no_active_state",
        })}`
      );
      return;
    }
    this.workerHost.sendCommand(state.ownerId, handle.runId, command);
    this.recordCommandSent(handle.runId, command);
  }

  cancel(handle: WorkerExecutionHandle): void {
    const state = this.states.get(handle.runId);
    if (!state) return;
    if (state.status === "ready") {
      this.sendCommand(handle, {
        type: "cancel",
        commandId: generateId(),
        runId: handle.runId,
        conversationId: handle.conversationId,
      });
      return;
    }
    state.cancelled = true;
  }

  private recordCommandSent(runId: string, command: CommandPayload): void {
    this.receiver
      .recordCommandSent({
        runId,
        commandId: command.commandId,
        commandType: command.type,
      })
      .catch((err) =>
        this.logger.warn(
          `record command sent failed ${safeLogJson({
            runId,
            commandType: command.type,
            ...errorLogFields(err),
          })}`
        )
      );
  }

  private onAcquireFailed(runId: string, err: unknown): void {
    this.logger.warn(
      `acquire local instance failed ${safeLogJson({ runId, ...errorLogFields(err) })}`
    );
    this.states.delete(runId);
    this.notifyWorkerError(
      runId,
      `acquire local instance failed: ${String(err)}`
    );
  }

  private notifyWorkerError(runId: string, error: string): void {
    this.receiver
      .notifyWorkerError(runId, error)
      .catch(swallow(this.logger, `notify worker error for run ${runId}`));
  }

  private notifyCancelledBeforeReady(runId: string): void {
    this.receiver
      .notifyCancelledBeforeReady(runId)
      .catch(
        swallow(this.logger, `notify cancelled before ready for run ${runId}`)
      );
  }

  terminateExecution(runId: string, reason: string): void {
    this.logger.warn(
      `terminating local run session ${safeLogJson({ runId, reason })}`
    );
    this.cleanup(runId);
  }

  cleanup(runId: string): void {
    this.workerHost.cleanupRun(runId);
    this.states.delete(runId);
  }

  cleanupInterruptedExecution(runtimeInstanceId: string): Promise<void> {
    return this.workerHost.recoverOrphanLocalInstance(runtimeInstanceId);
  }
}
