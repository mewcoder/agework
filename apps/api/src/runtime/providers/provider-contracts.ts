import type {
  CommandPayload,
  WorkerExecutionHandle,
  WorkerExecutionStartInput,
} from "@agework/shared/protocol";
import type { RunEventReceiver } from "./run-event-receiver.port";
import type { CommandPort } from "./command-port";
import type { AccessPort } from "./access-port";

/**
 * Run 驱动的 per-run 执行面：把 RuntimeTarget + RunConfig 跑成一次 worker execution，
 * 维护 run 事件回传。由 RunDriver 经 registry 驱动。
 */
export interface WorkerExecutionProvider {
  readonly type: string;
  /** 注入 run 事件 receiver；由 run 层在启动时一次性 set 进每个 provider。 */
  setRunEventReceiver(receiver: RunEventReceiver): void;
  /** 注入命令通道；由 run 层注入（local provider 不使用，故可选）。 */
  setCommandPort?(commands: CommandPort): void;
  /** 注入鉴权通道；由 run 层注入（local provider 不使用，故可选）。 */
  setAccessPort?(access: AccessPort): void;
  startWorkerExecution(input: WorkerExecutionStartInput): WorkerExecutionHandle;
  sendCommand(handle: WorkerExecutionHandle, command: CommandPayload): void;
  cancel(handle: WorkerExecutionHandle): void;
  getHandle(runId: string): WorkerExecutionHandle | undefined;
  /** 强制终止单次 run 的执行会话；不得停止可复用 runtime resource。 */
  terminateExecution?(runId: string, reason: string): void;
  cleanup(runId: string): void;
}

/**
 * Runtime 驱动的 runtime 实例（进程/容器）生命周期面，与 per-run 执行正交：
 * runtime 实例可跨多个 run 复用、独立于单次 run 存活。由 RuntimeService /
 * RuntimeInstanceLifecycleUseCase / RunRecoveryUseCase 经 registry 驱动。
 */
export interface RuntimeInstanceManager {
  /** 服务重启后，根据持久化的 runtimeInstanceId 终止孤儿 run 对应的进程/容器。幂等。 */
  recoverOrphan(runtimeInstanceId: string): Promise<void>;
  /** 停止并删除指定 owner 对应的持久容器/沙箱（仅持久实例 provider）。 */
  shutdownRuntimeInstance?(ownerId: string): void;
}

/** 同一 provider 对象同时承担两面：执行通道（run 驱动）+ 环境所有者（runtime 驱动）。 */
export type RuntimeProvider = WorkerExecutionProvider & RuntimeInstanceManager;
