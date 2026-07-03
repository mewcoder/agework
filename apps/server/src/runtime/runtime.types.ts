import type {
  IsolationScope,
  RuntimePlacement,
  SandboxRuntimePlacement,
} from "@agework/shared/protocol";
import type { ChildProcess } from "node:child_process";
import type { IsolationScope as ConfigIsolationScope } from "../config/config.service";

// ── Sandbox engine 契约类型(runtime 的 SandboxRuntimeProvider 与
// DockerSandboxEngine/OpenSandboxEngine 共用的 runtime 内部类型契约面) ──

export type SandboxEngineType = "docker" | "opensandbox";

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
  /** OpenSandbox 专用:resource 恢复时传已有的 RuntimeTarget.id */
  runtimeInstanceId?: string;
};

export type SandboxRuntime = {
  engineType: SandboxEngineType;
  runtimeInstanceId: string;
  workspaceMountPath: string;
};

/** 类型守卫:narrow 出 sandbox 分支(placement.sandbox 必填)。 */
export function isSandboxPlacement(
  placement: RuntimePlacement
): placement is SandboxRuntimePlacement {
  return placement.runtimeType === "sandbox";
}

// ── Local Provider 契约类型(runtime 的 LocalRuntimeProvider fork 机制内部
// 使用的类型契约面) ──

export type LocalLaunchInput = {
  runId: string;
  env: Record<string, string>;
};

export type LocalInstanceHandle = {
  runtimeInstanceId: string;
  /** fork() 返回的 ChildProcess——调用方(runtime 的 LocalRuntimeProvider)只用它接收进程生命周期信号(exit)与终止(kill),业务收发走 HTTP。 */
  channel: ChildProcess;
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
      runtimeType: "sandbox";
      isolationScope: ConfigIsolationScope;
      sandboxEngine: SandboxEngineType;
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

/** prepareEnvironment 的产物：container 返回容器 id，process 返回空。 */
export type RuntimeEnvHandle = { runtimeInstanceId?: string };

/** 停止/回收一个实例所需的最小信息，由调用方从 WorkerRegistry DB 行派生。 */
export type RuntimeInstanceRef = {
  runtimeType: string;
  ownerId: string;
  runtimeInstanceId: string;
  isolationScope: string;
};

/** 某一 runtimeType 的运行形态：自声明类型 + 备环境/拉 worker/拆除/回收孤儿。 */
export interface RuntimeProvider {
  readonly type: string;
  readonly placementKind: "container" | "process";
  prepareEnvironment(ctx: RuntimeLaunchContext): Promise<RuntimeEnvHandle>;
  launchWorker(
    ctx: RuntimeLaunchContext,
    env: RuntimeEnvHandle
  ): Promise<{ runtimeInstanceId: string }>;
  teardown(ref: RuntimeInstanceRef): Promise<void> | void;
  recoverOrphan?(ref: RuntimeInstanceRef): Promise<void> | void;
}

export const RUNTIME_PROVIDERS = Symbol("RUNTIME_PROVIDERS");
