import type {
  IsolationScope,
  RuntimePlacement,
  SandboxRuntimePlacement,
} from "@agework/shared/protocol";
import type { ChildProcess } from "node:child_process";
import type { IsolationScope as ConfigIsolationScope } from "../config/config.service";

// ── Sandbox engine 契约类型(worker-host 的 SandboxInstanceExecutor 与 runtime 的
// DockerSandboxEngine/OpenSandboxEngine 共用,是这两个模块之间唯一合法的类型契约面) ──

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

// ── Local Provider 契约类型(worker-host 的 LocalInstanceExecutor 与 runtime 的
// LocalRuntimeProvider 之间唯一合法的类型契约面) ──

export type LocalLaunchInput = {
  runId: string;
  env: Record<string, string>;
};

export type LocalInstanceHandle = {
  runtimeInstanceId: string;
  /** fork() 返回的 ChildProcess——调用方(worker-host 的 LocalInstanceExecutor)自行接手后续 IPC 收发。 */
  channel: ChildProcess;
};

// ── Placement 解析契约类型(worker-host 的 WorkerHostService.resolveRuntimeTarget()
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
