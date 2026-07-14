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
  /** worker 回连 server 的地址。默认 127.0.0.1:<port><path>;docker / opensandbox
   *  provider 会把 127.0.0.1/localhost 换成 host.docker.internal。远程部署经
   *  AGEWORK_SERVER_BASE_URL 覆盖成真实可达地址,不触发替换。 */
  serverBaseUrl: string;
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
 * 某一 runtimeType 的运行形态:自声明类型 + 三段生命周期。
 * - start:建环境 + 起 worker（容器 create/start 合一，native 是 fork）。onExit 是
 *   调用方本地专属的子进程退出钩子,只有 native provider 真正接线(容器形态没有
 *   本地子进程可监听);registered Host 不传、providers 也不转发它。
 * - stop:owner 仍在,停 worker 但保留运行实例（容器 stop/pause，native 杀进程）。
 * - destroy:owner 永久消失,删除运行实例（容器 rm/delete，native 杀进程）。
 */
export interface RuntimeProvider {
  readonly type: RuntimeType;
  start(
    ctx: RuntimeLaunchContext,
    onExit?: () => void
  ): Promise<{ runtimeInstanceId: string }>;
  stop(ref: RuntimeInstanceRef): Promise<void> | void;
  destroy(ref: RuntimeInstanceRef): Promise<void> | void;
}
