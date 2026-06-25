import type {
  ControlPayload,
  RuntimePlacement,
  RuntimeResourceHandle,
  WorkerExecutionHandle,
  WorkerExecutionStartInput,
} from "@agework/shared/protocol";
import type { RunEventReceiver } from "../run-event-receiver";

export type ProviderWorkerExecutionStartInput = WorkerExecutionStartInput;

/** API 控制面侧的 provider 接口。 */
export interface RuntimeProvider {
  readonly type: string;
  /** 注入 run 事件 receiver；由 run 层在启动时一次性 set 进每个 provider。 */
  setRunEventReceiver(receiver: RunEventReceiver): void;
  startWorkerExecution(input: WorkerExecutionStartInput): WorkerExecutionHandle;
  sendControl(handle: WorkerExecutionHandle, control: ControlPayload): void;
  cancel(handle: WorkerExecutionHandle): void;
  getHandle(runId: string): WorkerExecutionHandle | undefined;
  /** 收到 worker 心跳时调用，重置该 run 的心跳 watchdog 计时。 */
  heartbeat(runId: string): void;
  /** Run 终态后清理 provider 内部状态（心跳定时器等）。幂等。 */
  cleanup(runId: string): void;
  /** 服务重启后，根据持久化的 runtimeResourceId 终止孤儿 run 对应的进程/容器。幂等。 */
  recoverOrphan(runtimeResourceId: string): Promise<void>;
  /** 收到 worker 心跳时按 runtime resource key 喂容器级 watchdog。 */
  heartbeatRuntimeResource?(resourceKey: string): void;
  /** 停止并删除指定 runtime resource key 对应的持久容器/沙箱。 */
  shutdownRuntimeResource?(resourceKey: string): void;
}

export interface RuntimeResourceProvider {
  readonly type: string;
  provision(
    placement: RuntimePlacement
  ): RuntimeResourceHandle | Promise<RuntimeResourceHandle>;
}

export interface WorkerExecutionProvider {
  readonly type: string;
  startWorkerExecution(
    input: ProviderWorkerExecutionStartInput
  ): WorkerExecutionHandle;
  sendControl(handle: WorkerExecutionHandle, control: ControlPayload): void;
  cancel(handle: WorkerExecutionHandle): void;
  cleanup(runId: string): void;
}
