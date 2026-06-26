import type {
  CommandPayload,
  WorkerExecutionHandle,
  WorkerExecutionStartInput,
} from "@agework/shared/protocol";
import type { RunEventReceiver } from "./run-event-receiver";

/** Run 层驱动的执行切片：把 RuntimeTarget + RunConfig 跑成一次 worker execution。 */
export interface WorkerExecutionProvider {
  readonly type: string;
  startWorkerExecution(input: WorkerExecutionStartInput): WorkerExecutionHandle;
  sendCommand(handle: WorkerExecutionHandle, command: CommandPayload): void;
  cancel(handle: WorkerExecutionHandle): void;
  cleanup(runId: string): void;
}

/** API 控制面侧的 provider 接口（执行切片 + 事件接线 + runtime resource 生命周期）。 */
export interface RuntimeProvider extends WorkerExecutionProvider {
  /** 注入 run 事件 receiver；由 run 层在启动时一次性 set 进每个 provider。 */
  setRunEventReceiver(receiver: RunEventReceiver): void;
  getHandle(runId: string): WorkerExecutionHandle | undefined;
  /** 收到 worker 心跳时调用，重置该 run 的心跳 watchdog 计时。 */
  heartbeat(runId: string): void;
  /** 服务重启后，根据持久化的 runtimeInstanceId 终止孤儿 run 对应的进程/容器。幂等。 */
  recoverOrphan(runtimeInstanceId: string): Promise<void>;
  /** 收到 worker 心跳时按 ownerId 喂容器级 watchdog。 */
  heartbeatRuntimeInstance?(ownerId: string): void;
  /** 停止并删除指定 owner 对应的持久容器/沙箱。 */
  shutdownRuntimeInstance?(ownerId: string): void;
}
