// ── SandboxEngine 类型标识 ──────────────────────────────────────────────

export type SandboxEngineType = "docker" | "opensandbox";

// ── Sandbox 放置信息（从 RuntimePlacement 提取） ──────────────────────────

export type SandboxPlacement = {
  isolationScope: import("@agework/shared/protocol").IsolationScope;
  resourceKey: string;
  workspaceId: string;
  workspaceHostPath: string;
  workspaceMountPath: string;
};

// ── Engine 启动输入 ────────────────────────────────────────────────────

export type SandboxStartInput = {
  placement: SandboxPlacement;
  image: string;
  apiBaseUrl: string;
  accessKey: string;
  env: Record<string, string>;
  metadata: Record<string, string>;
  runtimeLogHostPath?: string;
  runtimeLogMountPath?: string;
  /**
   * DB-backed ownership check supplied by the provider. Engines may use a
   * Docker/OpenSandbox resource id as a lookup key, but must not infer binding
   * from names or labels.
   */
  isExpectedRuntimeInstance?: (runtimeResourceId: string) => Promise<boolean>;
  /** OpenSandbox 专用：resource 恢复时传已有的 RuntimeResource.id */
  runtimeResourceId?: string;
};

// ── Engine 返回的运行时信息 ────────────────────────────────────────────

export type SandboxRuntime = {
  engineType: SandboxEngineType;
  runtimeResourceId: string;
  workspaceMountPath: string;
};

// ── SandboxEngine 接口 ─────────────────────────────────────────────────

export interface SandboxEngine {
  readonly type: SandboxEngineType;

  /**
   * 获取或创建沙箱运行环境。
   * - 如果对应 resourceKey 的沙箱已存在（内存/DB），返回已有实例。
   * - 如果不存在，创建新实例并返回。
   */
  getOrCreate(input: SandboxStartInput): Promise<SandboxRuntime>;

  /**
   * 在已有沙箱中启动 worker 进程。
   * Docker engine 是空操作（worker 通过容器 entrypoint 启动）。
   * OpenSandbox engine 需要调 sandbox.runCommand()。
   */
  startWorker(runtime: SandboxRuntime, input: SandboxStartInput): Promise<void>;

  /**
   * 停止沙箱运行环境（不销毁）。
   * Docker: docker stop（保留容器对象与可写层数据，可通过 resume() 恢复）。
   * OpenSandbox: pause sandbox（保留状态，可通过 resume() 恢复）。
   */
  stop(runtimeResourceId: string): Promise<void>;

  /**
   * 恢复一个此前被 stop() 的沙箱运行环境（可选）。
   * Docker: docker start <id>，复用原容器及其可写层数据。
   * OpenSandbox: resume sandbox，复用 paused sandbox。
   */
  resume?(
    runtimeResourceId: string,
    input: SandboxStartInput
  ): Promise<SandboxRuntime>;

  /**
   * 服务重启后，根据持久化的 runtimeResourceId 终止孤儿资源。幂等。
   */
  recoverOrphan(runtimeResourceId: string): Promise<void>;

  /**
   * 检查沙箱是否健康。可选，用于 DB resource 恢复时验证。
   */
  isHealthy?(runtimeResourceId: string): Promise<boolean>;
}

// ── DI token ──────────────────────────────────────────────────────────

/**
 * DI token：聚合所有已注册的 SandboxEngine 实现。
 * 新增 engine 时，只需新建一个实现类并加入 runtime.module.ts
 * 的 providers 数组与本 token 的 inject 列表。
 */
export const SANDBOX_ENGINES = Symbol("SANDBOX_ENGINES");
