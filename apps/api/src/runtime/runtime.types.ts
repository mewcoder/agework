import type { IsolationScope, RuntimePlacement, SandboxRuntimePlacement } from "@agework/shared/protocol";

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
