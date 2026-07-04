import type {
  IsolationScope,
  RuntimeSpec,
} from "@agework/shared/protocol";

// ── runtime 类型:这个扩展点实现了哪些 runtime 的权威事实 ──────────────────

export const SUPPORTED_RUNTIME_TYPES = [
  "local",
  "docker",
  "opensandbox",
] as const;

export type RuntimeType = (typeof SUPPORTED_RUNTIME_TYPES)[number];

/** DB 边界收窄:把任意字符串校验/收窄成 RuntimeType(非法值当场暴露)。 */
export function isRuntimeType(value: string): value is RuntimeType {
  return (SUPPORTED_RUNTIME_TYPES as readonly string[]).includes(value);
}

// ── 包对外 config:server 用 ConfigService 拼好后由工厂喂入,包不认识 ConfigService ──

/** docker / opensandbox 共享的容器侧 config。 */
export type SandboxProviderConfig = {
  workerImage: string;
  runtimeLogHostPath: string;
  apiBaseUrl: string;
};

/** OpenSandbox SDK 连接参数。 */
export type OpenSandboxConnectionConfig = {
  domain: string;
  protocol: "http" | "https";
  apiKey: string | undefined;
  useServerProxy: boolean;
};

/** local provider 的 config:worker 入口路径由 server require.resolve 后传入,
 *  包因此不依赖 @agework/worker。 */
export type LocalProviderConfig = {
  apiBaseUrl: string;
  workerEntryPath: string;
  tsxCliPath: string;
};

/** createRuntimeProviders 的唯一入参。 */
export type RuntimeConfig = {
  workerImage: string;
  runtimeLogHostPath: string;
  /** 容器 worker 访问宿主 API 的 base(host.docker.internal:<port>/...)。docker + opensandbox 共用。 */
  containerApiBaseUrl: string;
  local: LocalProviderConfig;
  openSandbox: OpenSandboxConnectionConfig;
};

// ── Sandbox 启动输入(docker / opensandbox provider 与 buildSandboxStartInput
// 之间的内部契约,不导出) ──

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
  isExpectedRuntimeInstance?: (runtimeInstanceId: string) => Promise<boolean>;
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
  | { runtimeType: "local" }
  | {
      runtimeType: "docker" | "opensandbox";
      isolationScope: IsolationScope;
    }
);

// ── RuntimeProvider 契约 ──

/** provisioner 交给 provider 的一次启动上下文。workerEnv 是共享的 worker 协议
 *  env(AGEWORK_WORKER_* + startToken),provider 内部再合并自己的 infra env。 */
export type RuntimeLaunchContext = {
  runtimeType: RuntimeType;
  ownerId: string;
  workspaceId: string;
  runId: string;
  placement: RuntimeSpec;
  workerEnv: Record<string, string>;
  /** DB-backed ownership check for sandbox docker name-conflict recovery。 */
  isExpectedRuntimeInstance?: (runtimeInstanceId: string) => Promise<boolean>;
  /** local provider 的子进程 exit 回调。 */
  onWorkerExit?: () => void;
};

/** 停止/销毁一个实例所需的最小信息,由调用方从 WorkerRegistry DB 行派生。 */
export type RuntimeInstanceRef = {
  runtimeType: RuntimeType;
  ownerId: string;
  runtimeInstanceId: string;
  isolationScope: string;
};

/**
 * 某一 runtimeType 的运行形态:自声明类型 + 三段生命周期。
 * - start:建环境 + 起 worker（容器 create/start 合一，local 是 fork）。
 * - stop:owner 仍在,停 worker 但保留载体（容器 stop/pause，local 杀进程）。
 * - destroy:owner 永久消失,删除载体（容器 rm/delete，local 杀进程）。
 */
export interface RuntimeProvider {
  readonly type: RuntimeType;
  start(ctx: RuntimeLaunchContext): Promise<{ runtimeInstanceId: string }>;
  stop(ref: RuntimeInstanceRef): Promise<void> | void;
  destroy(ref: RuntimeInstanceRef): Promise<void> | void;
}
