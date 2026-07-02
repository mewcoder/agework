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

/** 一次 run 的执行状态(run 层持有)。 */
type WorkerRunState = {
  handle: WorkerExecutionHandle;
  ownerId: string;
  status: "acquiring" | "ready";
  cancelled: boolean;
};

/**
 * 统一 run executor:per-run 执行编排归 run 层,取得/释放/回收 runtime 实例统一经
 * `WorkerHostService.resolveInstance()`/`releaseInstanceForRun()`/`recoverOrphanInstance()`
 * 完成——runtimeType(sandbox/local)判断被 worker-host 内部吸收,run 层不再需要认识
 * 这个区别,也因此不再需要按 runtimeType 分别持有两个执行器类(设计文档第一节)。
 *
 * 就绪后直接对 worker-host 完成 openSession / 命令下发 / cleanup,命令不绕经 runtime。
 * 就绪/早取消/失败由 resolveInstance 结果一次性回流。
 */
@Injectable()
export class WorkerRunExecutor implements RunExecutor {
  private readonly logger = new Logger(WorkerRunExecutor.name);
  private readonly states = new Map<string, WorkerRunState>();
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

    // resolveInstance 同步调用（spec 要求 start() 同步触发取得），但它可能同步抛错；
    // 用 try/catch 把同步异常与 .catch 的异步 rejection 收敛到同一清理，run 转 error
    // 终态而非卡在 acquiring。
    try {
      this.workerHost
        .resolveInstance(input)
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

    // outcome === "ready"：取消若早于就绪到达，释放实例并转 cancelled 终态，不开 session。
    if (state.cancelled) {
      this.workerHost.releaseInstanceForRun(state.handle.runtimeType, runId);
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
        `send command dropped ${safeLogJson({
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
    // 实例 ready 之前到达的取消不下发命令：标记 cancelled，由 resolveInstance 就绪
    // 那刻转 cancelled 终态。
    state.cancelled = true;
    this.workerHost.releaseInstanceForRun(handle.runtimeType, handle.runId);
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
      `resolve instance failed ${safeLogJson({
        runId,
        ...errorLogFields(err),
      })}`
    );
    this.states.delete(runId);
    this.notifyWorkerError(runId, `resolve instance failed: ${String(err)}`);
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
      `terminating run session ${safeLogJson({ runId, reason })}`
    );
    this.cleanup(runId);
  }

  cleanup(runId: string): void {
    // releaseInstanceForRun 需要 runtimeType 才能路由到 sandbox/local；这个 executor
    // 不再像旧的按类型分开的两个类那样自带类型，只能从 state 里取——state 不存在
    // （重复 cleanup / 从未 start 过）时没有 runtimeType 可用，跳过即可，因为对应的
    // acquire 侧状态同样不存在，没有东西需要释放。
    const state = this.states.get(runId);
    this.workerHost.cleanupRun(runId);
    if (state) {
      this.workerHost.releaseInstanceForRun(state.handle.runtimeType, runId);
    }
    this.states.delete(runId);
  }

  cleanupInterruptedExecution(
    runtimeType: string,
    runtimeInstanceId: string
  ): Promise<void> {
    return this.workerHost.recoverOrphanInstance(
      runtimeType,
      runtimeInstanceId
    );
  }
}
