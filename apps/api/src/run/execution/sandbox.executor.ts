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

/** 一次 sandbox run 的执行状态（run 层持有，与 LocalRunExecutor 的 states 对称）。 */
type SandboxRunState = {
  handle: WorkerExecutionHandle;
  ownerId: string;
  status: "acquiring" | "ready";
  cancelled: boolean;
};

/**
 * sandbox run executor：per-run 执行编排归 run 层。runtime 只负责为本 run 取得持久容器实例
 * （acquireInstanceForRun），就绪后本类直接对 worker-host 完成 openSession / 命令下发 / cleanup，
 * 命令不再绕经 runtime。就绪/早取消/失败由 acquire 结果一次性回流，取代旧的 SandboxWorkerEventPort。
 *
 * 命令的 command.sent trace 由本类（run 侧）在下发时记录，与 LocalRunExecutor 对称；
 * 首个 user_message 在实例就绪后由本类显式下发，触发持久 worker 为本 run 拉起 runner。
 */
@Injectable()
export class SandboxRunExecutor implements RunExecutor {
  readonly type = "sandbox" as const;
  private readonly logger = new Logger(SandboxRunExecutor.name);
  private readonly states = new Map<string, SandboxRunState>();
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

    // acquire 同步调用（spec 要求 start() 同步触发取得），但它可能同步抛错（如目标非
    // sandbox placement）；用 try/catch 把同步异常与 .catch 的异步 rejection 收敛到同一清理，
    // run 转 error 终态而非卡在 acquiring。
    try {
      this.workerHost
        .acquireSandboxInstanceForRun(input)
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
    // 兜底同 tick 竞态：settleReady 已结算为 ready、但本 onAcquired 尚未执行的微任务间隙里
    // cancel() 抢入，把 state.cancelled 置真（此时 status 仍为 acquiring，不会下发 cancel 命令）。
    if (state.cancelled) {
      this.workerHost.releaseSandboxInstanceForRun(runId);
      this.states.delete(runId);
      this.notifyCancelledBeforeReady(runId);
      return;
    }

    state.handle.runtimeInstanceId = result.runtimeInstanceId;
    state.status = "ready";
    input.onRuntimeInstanceIdReady?.(result.runtimeInstanceId);

    // 实例就绪后由 run 侧打开 worker session，并下发首个 user_message 触发持久 worker 拉起 runner。
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
        `sandbox send command dropped ${safeLogJson({
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
    // 实例 ready 之前到达的取消不下发命令：标记 cancelled，由 acquire 就绪那刻转 cancelled 终态。
    state.cancelled = true;
    this.workerHost.releaseSandboxInstanceForRun(handle.runId);
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
      `acquire sandbox instance failed ${safeLogJson({
        runId,
        ...errorLogFields(err),
      })}`
    );
    this.states.delete(runId);
    this.notifyWorkerError(
      runId,
      `acquire sandbox instance failed: ${String(err)}`
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
      `terminating sandbox run session ${safeLogJson({ runId, reason })}`
    );
    this.cleanup(runId);
  }

  cleanup(runId: string): void {
    this.workerHost.cleanupRun(runId);
    this.workerHost.releaseSandboxInstanceForRun(runId);
    this.states.delete(runId);
  }

  cleanupInterruptedExecution(runtimeInstanceId: string): Promise<void> {
    return this.workerHost.recoverOrphanSandboxInstance(runtimeInstanceId);
  }
}
