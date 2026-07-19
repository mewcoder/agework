export type WorkerScope = "user" | "workspace";

export type SandboxPlacementInfo = {
  scope: WorkerScope;
  mountTarget: string;
};

type RuntimeSpecBase = {
  runtimeType: RuntimeType;
  userId: string;
  workspaceId: string;
  hostPath: string;
  runtimePath: string;
  /** 日志目录在执行环境内的路径(native 下即宿主机日志目录)。 */
  runtimeLogDir: string;
};

export type NativeRuntimeSpec = RuntimeSpecBase & {
  runtimeType: "native";
  sandbox?: never;
};

export type SandboxRuntimeSpec = RuntimeSpecBase & {
  sandbox: SandboxPlacementInfo;
};

export type RuntimeSpec = RuntimeSpecBase & {
  sandbox?: SandboxPlacementInfo;
};

/** Runtime type 是插件声明的稳定标识，不由 SDK 维护封闭枚举。 */
export type RuntimeType = string;

/** runtime type/package manifest id 的最小格式约束。 */
export function isRuntimeType(value: string): value is RuntimeType {
  return /^[a-z][a-z0-9-]*$/.test(value);
}

/** Host 传给所有 provider 的通用启动配置，不含任何内建或插件私有字段。 */
export type RuntimeProviderConfig = {
  workerImage: string;
  runtimeLogHostPath: string;
  /** worker 回连所属 Runtime Host 的 HTTP 地址。容器 provider 会把
   *  127.0.0.1/localhost 换成 host.docker.internal。 */
  workerApiBaseUrl: string;
};

/**
 * Runtime Host 内部派生的结构化隔离身份。scope 是最大共享边界，subjectId 是
 * 该 scope 下的复用主体(user scope → userId, workspace scope → workspaceId)。
 * provider 只接收隔离事实，不再从 ownerId 字符串反解析。
 */
export type RuntimeIsolation = {
  scope: WorkerScope;
  subjectId: string;
};

// ── Sandbox 启动输入(docker / opensandbox provider 与 buildSandboxStartInput
// 之间的内部契约,不导出) ──

export type SandboxPlacement = {
  scope: WorkerScope;
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
};

// ── Placement 解析契约 ──

/** 入参由 run 层用部署默认值补齐并校验完毕,这里只做纯 placement 计算。
 *  V3: scope 始终存在(native 也是 "workspace"),不再用 scope === undefined 暗示 native。 */
export type RuntimeSpecInput = {
  userId: string;
  workspaceId: string;
  workspaceRootPath: string;
  userWorkspaceRootPath: string;
  runtimeLogHostPath: string;
  runtimeType: RuntimeType;
  scope: WorkerScope;
};

// ── RuntimeProvider 契约 ──

/** provisioner 交给 provider 的一次启动上下文。workerEnv 是共享的 worker 协议
 *  env(AGEWORK_WORKER_* + startToken),provider 内部再合并自己的 infra env。
 *  跨进程/跨机器可序列化(RuntimeHost 经隧道 RPC 原样转发),
 *  因此不含任何函数字段——调用方本地专属的钩子经 RuntimeProvider.start() 的
 *  第二参数传,不进 ctx。 */
export type RuntimeLaunchContext = {
  runtimeType: RuntimeType;
  /** Runtime 内部控制身份;provider 的资源控制身份是 start() 返回的 runtimeInstanceId。 */
  workerId: string;
  runId: string;
  workspaceId: string;
  /** 结构化隔离身份,由 Runtime 从 placement 唯一派生。 */
  isolation: RuntimeIsolation;
  placement: RuntimeSpec;
  workerEnv: Record<string, string>;
};

/**
 * 停止/销毁一个实例所需的最小信息。provider 的资源控制键是 runtimeInstanceId
 * (Docker containerId / OpenSandbox sandboxId / Native pid:token);workerId
 * 仅供 native provider 索引内存中的 child channel。
 */
export type RuntimeInstanceRef = {
  runtimeType: RuntimeType;
  workerId: string;
  runtimeInstanceId: string;
};

export type RuntimeStartOptions = {
  /** Host 取消 acquisition/timeout 时触发；provider 应尽快停止尚未 provision 的启动。 */
  signal?: AbortSignal;
};

/**
 * 某一 runtimeType 的运行形态:自声明类型 + 生命周期策略。
 * - start:建环境 + 起 worker（容器 create/start 合一，native 是 fork）。onExit 是
 *   调用方本地专属的子进程退出钩子,只有 native provider 真正接线(容器形态没有
 *   本地子进程可监听);registered Host 不传、providers 也不转发它。
 * - release:worker 从 Host 消失；是否保留载体由 provider 自己决定。
 * - destroy:启动回滚/孤儿清理时强制删除载体。
 * stop 保留为 provider 内部可用的缓存原语，不由 Host 选择业务语义。
 */
export interface RuntimeProvider {
  readonly type: RuntimeType;
  /**
   * Host 启动时清理本 provider 留下、且已无法续管的本机资源。
   * 可选能力；实现必须只清理自己具有充分 authority 的资源，不能做跨重启 adopt。
   */
  cleanupOrphans?(): Promise<void> | void;
  start(
    ctx: RuntimeLaunchContext,
    onExit?: () => void,
    /** 资源一旦拿到稳定 id 立即回报，Host 可在后续启动步骤卡住时回滚。 */
    onProvisioned?: (runtimeInstanceId: string) => void,
    options?: RuntimeStartOptions
  ): Promise<{ runtimeInstanceId: string }>;
  release(ref: RuntimeInstanceRef): Promise<void> | void;
  stop(ref: RuntimeInstanceRef): Promise<void> | void;
  destroy(ref: RuntimeInstanceRef): Promise<void> | void;
}

/**
 * 外部 runtime provider 的装配边界。插件声明自己的 runtimeType，并用 Host 提供的
 * 通用 RuntimeProviderConfig 构造实例；插件私有配置由 create 闭包自行持有。
 */
export interface RuntimeProviderPlugin {
  readonly apiVersion: 1;
  readonly type: RuntimeType;
  readonly displayName: string;
  readonly scopes: readonly WorkerScope[];
  /** Host 能力刷新钩子；未提供时仅表示插件已成功加载。 */
  probe?():
    | Promise<{ available: boolean; reason?: string }>
    | { available: boolean; reason?: string };
  create(config: RuntimeProviderConfig): RuntimeProvider;
}

/** 插件包的标准模块出口；Host 不依赖任何具体插件包名。 */
export interface RuntimePluginModule {
  createRuntimePlugin?: () => RuntimeProviderPlugin;
}
