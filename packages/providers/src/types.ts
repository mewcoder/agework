import type { WorkerScope, RuntimeSpec } from "@agework/shared/protocol";

// ── runtime 类型:这个扩展点实现了哪些 runtime 的权威事实 ──────────────────

export const SUPPORTED_RUNTIME_TYPES = [
  "native",
  "docker",
  "opensandbox",
] as const;

export type RuntimeType = (typeof SUPPORTED_RUNTIME_TYPES)[number];

/** DB 边界收窄:把任意字符串校验/收窄成 RuntimeType(非法值当场暴露)。 */
export function isRuntimeType(value: string): value is RuntimeType {
  return (SUPPORTED_RUNTIME_TYPES as readonly string[]).includes(value);
}

// ── 包对外 config:server 用 ConfigService 拼好后由工厂喂入,包不认识 ConfigService ──

/** OpenSandbox SDK 连接参数。 */
export type OpenSandboxConnectionConfig = {
  domain: string;
  protocol: "http" | "https";
  apiKey: string | undefined;
  useServerProxy: boolean;
};

/** native provider 的 config:agework-runtime 产物入口(纯 JS bundle,ESM)的绝对路径,
 *  由 server 备好后传入。provider 用 `node` fork 它并注入 AGEWORK_WORKER_ROLE=worker,
 *  因此包既不依赖 @agework/worker 也不依赖 tsx。 */
export type NativeProviderConfig = {
  runtimeEntryPath: string;
};

/** createRuntimeResolver 的唯一入参。 */
export type RuntimeConfig = {
  workerImage: string;
  runtimeLogHostPath: string;
  /** worker 回连所属 Runtime Host 的 HTTP 地址。容器 provider 会把
   *  127.0.0.1/localhost 换成 host.docker.internal。 */
  workerApiBaseUrl: string;
  native: NativeProviderConfig;
  openSandbox: OpenSandboxConnectionConfig;
};

// ── Sandbox 启动输入(docker / opensandbox provider 与 buildSandboxStartInput
// 之间的内部契约,不导出) ──

export type SandboxPlacement = {
  scope: WorkerScope;
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
  /** 见 RuntimeLaunchContext.expectedRuntimeInstanceId 的三态语义。 */
  expectedRuntimeInstanceId?: string | null;
};

// ── Placement 解析契约 ──

/** 入参由 run 层用部署默认值补齐并校验完毕,这里只做纯 placement 计算。 */
export type RuntimeSpecInput = {
  userId: string;
  workspaceId: string;
  workspaceRootPath: string;
  userWorkspaceRootPath: string;
  runtimeLogHostPath: string;
} & (
  | { runtimeType: "native" }
  | {
      runtimeType: "docker" | "opensandbox";
      scope: WorkerScope;
    }
);

// ── RuntimeProvider 契约 ──

/** provisioner 交给 provider 的一次启动上下文。workerEnv 是共享的 worker 协议
 *  env(AGEWORK_WORKER_* + startToken),provider 内部再合并自己的 infra env。
 *  跨进程/跨机器可序列化(RuntimeHost 经隧道 RPC 原样转发),
 *  因此不含任何函数字段——调用方本地专属的钩子经 RuntimeProvider.start() 的
 *  第二参数传,不进 ctx。 */
export type RuntimeLaunchContext = {
  runtimeType: RuntimeType;
  ownerId: string;
  workspaceId: string;
  runId: string;
  placement: RuntimeSpec;
  workerEnv: Record<string, string>;
  /** 当前 workspace 绑定的 runtimeInstanceId(docker 容器名冲突恢复用),三态:
   *  `undefined` = 调用方未接入此特性,不做冲突恢复直接抛出原始错误;
   *  `null` = 调用方已接入但当前无绑定,冲突容器一定不是预期的,清理重建;
   *  `<id>` = 调用方已接入且有绑定,与冲突容器精确比较,相同则保留、不同则清理重建。 */
  expectedRuntimeInstanceId?: string | null;
};

/** 停止/销毁一个实例所需的最小信息,由调用方从 WorkerRegistry DB 行派生。 */
export type RuntimeInstanceRef = {
  runtimeType: RuntimeType;
  ownerId: string;
  workerId: string;
  runtimeInstanceId: string;
  scope: WorkerScope;
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
  start(
    ctx: RuntimeLaunchContext,
    onExit?: () => void,
    /** 资源一旦拿到稳定 id 立即回报，Host 可在后续启动步骤卡住时回滚。 */
    onProvisioned?: (runtimeInstanceId: string) => void
  ): Promise<{ runtimeInstanceId: string }>;
  release(ref: RuntimeInstanceRef): Promise<void> | void;
  stop(ref: RuntimeInstanceRef): Promise<void> | void;
  destroy(ref: RuntimeInstanceRef): Promise<void> | void;
}
