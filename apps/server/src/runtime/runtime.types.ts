import type {
  IsolationScope,
  RuntimePlacement,
} from "@agework/shared/protocol";
import type { IsolationScope as ConfigIsolationScope } from "../config/config.service";

// ── Sandbox 启动输入契约（docker / opensandbox 两个 provider 与共享 helper
// `buildSandboxStartInput` 之间的内部类型契约面） ──

export type SandboxPlacement = {
  isolationScope: IsolationScope;
  ownerId: string;
  workspaceId: string;
  workspaceHostPath: string;
  workspaceMountPath: string;
};

export type SandboxStartInput = {
  placement: SandboxPlacement;
  image: string;
  apiBaseUrl: string;
  env: Record<string, string>;
  metadata: Record<string, string>;
  runtimeLogHostPath?: string;
  runtimeLogMountPath?: string;
  /**
   * DB-backed ownership check supplied by the caller. Engines may use a
   * Docker/OpenSandbox resource id as a lookup key, but must not infer binding
   * from names or labels.
   */
  isExpectedRuntimeInstance?: (runtimeInstanceId: string) => Promise<boolean>;
};

// ── Placement 解析契约类型(worker-manager 的 WorkerManagerService.resolveRuntimeTarget()
// 与 runtime 的 RuntimeService.resolveRuntimeTarget() 之间唯一合法的类型契约面) ──

/** 入参由 run 层用部署默认值补齐并校验完毕,这里只做纯 placement 计算。 */
export type ResolveRuntimeTargetInput = {
  userId: string;
  workspaceId: string;
  workspaceRootPath: string;
  userWorkspaceRootPath: string;
  /** 宿主机日志目录(placement 据此算出执行环境内的 runtimeLogDir)。 */
  runtimeLogHostPath: string;
} & (
  | { runtimeType: "local" }
  | {
      runtimeType: "docker" | "opensandbox";
      isolationScope: ConfigIsolationScope;
    }
);

// ── RuntimeProvider 契约（worker-manager 的 WorkerProvisioner 与 runtime 的
// RuntimeProvider 实现之间的类型契约面；provider 抽象内聚在 runtime 模块内）──

/** provisioner 交给 provider 的一次启动上下文。workerEnv 是共享的 worker 协议
 *  env（AGEWORK_WORKER_* + startToken），provider 内部再合并自己的 infra env。 */
export type RuntimeLaunchContext = {
  runtimeType: string;
  ownerId: string;
  workspaceId: string;
  runId: string;
  placement: RuntimePlacement;
  workerEnv: Record<string, string>;
  /** DB-backed ownership check for sandbox docker name-conflict recovery
   *  (see SandboxStartInput.isExpectedRuntimeInstance)。由 worker-manager
   *  的 WorkerProvisioner 提供,runtime 自身不认识 WorkerRegistry。 */
  isExpectedRuntimeInstance?: (runtimeInstanceId: string) => Promise<boolean>;
  /** local provider 的子进程 exit 回调:通知调用方清理 owner 绑定态,使下一次
   *  run 能立即重新拉起,而不用等 stale registry 行超时。 */
  onWorkerExit?: () => void;
};

/** 停止/销毁一个实例所需的最小信息，由调用方从 WorkerRegistry DB 行派生。 */
export type RuntimeInstanceRef = {
  runtimeType: string;
  ownerId: string;
  runtimeInstanceId: string;
  isolationScope: string;
};

/**
 * 某一 runtimeType 的运行形态：自声明类型 + 三段生命周期。
 * - start：建环境 + 起 worker（容器 create/start 合一，local 是 fork）。
 * - stop：owner 仍在，停 worker 但保留载体（容器 stop/pause，local 杀进程）。
 * - destroy：owner 永久消失，删除载体（容器 rm/delete，local 杀进程）。
 * local 无独立载体，stop 与 destroy 同为杀进程。
 */
export interface RuntimeProvider {
  readonly type: string;
  start(ctx: RuntimeLaunchContext): Promise<{ runtimeInstanceId: string }>;
  stop(ref: RuntimeInstanceRef): Promise<void> | void;
  destroy(ref: RuntimeInstanceRef): Promise<void> | void;
}

export const RUNTIME_PROVIDERS = Symbol("RUNTIME_PROVIDERS");
