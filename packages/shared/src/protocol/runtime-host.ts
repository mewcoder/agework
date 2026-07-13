import type { AgentProviderConfig, CommandPayload } from "./channel";
import type { RunChannelMessage } from "./run-channel-message";
import type { AgentType } from "../common";
import type { RuntimeEnvConfig } from "../api/runtimes";
import type {
  WorkspaceFileListResponse,
  WorkspaceFileReadResponse,
  WorkspaceFileSearchResponse,
} from "../api/workspace-files";
import type {
  WorkspaceChangedFilesResponse,
  WorkspaceFileDiffResponse,
} from "../api/workspaces";

// ── Server ↔ Runtime Host 契约 ──────────────────────────────────────
//
// 设计定案见 docs/design/server-runtime-worker-target-architecture.md §4.2。
// Phase 1（契约先行）只收编 run 模块需要的执行面动词；环境/文件/观测全量动词
// 在 Phase 2 执行面搬家时扩入。标注「过渡」的成员服务于 Phase 1 的委托实现，
// Phase 2/3 收窄或删除。

/** worker 的服务范围：对用户是独享/共享承诺，对 Host 是复用粒度。 */
export type WorkerScope = "workspace" | "user";

/**
 * 隔离实现（native / docker / opensandbox），providers 扩展点决定取值。
 * 取代旧词 runtimeType——"runtime" 从此只出现在 Runtime Host 一个名字里。
 */
export type Isolation = string;

/** worker 复用的 owner 键：workspace-scope 用 workspaceId，user-scope 用 userId。 */
export type OwnerKey = `workspace:${string}` | `user:${string}`;

/**
 * worker 池的唯一键（不变量 2）：同一 (owner, isolation) 至多一个活跃 worker。
 * 池、观测、stopWorker、fence 全部用它，杜绝裸 ownerKey 在多 isolation 下撞车。
 */
export type WorkerKey = `${OwnerKey}#${string}`;

// 注意:本文件只放类型。owner/worker key 的构造函数(运行时值)内联在
// protocol/index.ts——原因见该文件 RUNTIME_TUNNEL_CLOSE_GONE 旁注释与
// common/index.ts 的 generateId 注释(type-stripping 消费方擦掉 type-only
// 导入后,无扩展名的运行时相对导入无法解析)。

/**
 * 一次 run 的放置决策：server 按 workspace 配置算好传入，Host 不解引用任何业务数据
 * （workspaceId/userId 对 Host 只是不透明的路由/复用/收尾键，见不变量 7）。
 */
export type RunPlacement = {
  owner: OwnerKey;
  scope: WorkerScope;
  isolation: Isolation;
  /** 目标 Host。过渡期沿用 Runtime 行 id（workspace.runtimeId），Phase 3 正名。 */
  runtimeHostId: string;
  workspaceId: string;
  userId: string;
  /** Host 派生 user 级挂载根用（执行机路径约定按用户名组织）。 */
  username: string;
  /** workspace 在宿主机上的根路径，Host 据此计算挂载/运行路径。 */
  workspacePath: string;
};

/**
 * 提交一次 run。只装业务输入——log 目录、mount、cwd、CLI 路径等执行机细节
 * 全部由 Host 派生（字段级决策，见设计文档 §4.2）。受理即返回，进度全走上行事件流。
 */
export type SubmitRunInput = {
  runId: string;
  conversationId: string;
  placement: RunPlacement;
  agentProviderConfig: AgentProviderConfig;
  /** 传给 Agent Adapter 的原始 run input（如 AG-UI RunAgentInput）。 */
  input: unknown;
};

/**
 * 执行载体标识（过渡）：Phase 1/2 仍持久化到 run 行供 admin 详情与重启恢复用，
 * Phase 3 admin 改走 listWorkers 现场查询后随之收窄。
 */
export type ExecutionRef = {
  runtimeType: string;
  runtimeInstanceId: string;
};

/** admin 观测用的 worker 快照（诊断面显式例外，业务代码禁止消费）。 */
export type WorkerSnapshot = {
  id: string;
  /** Phase 2: 池键 `OwnerKey#Isolation`，stopWorker 用。 */
  workerKey: WorkerKey;
  runtimeType: string;
  isolationScope: string;
  ownerId: string;
  runtimeInstanceId: string;
  status: string;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  workspaceBindings: Array<{
    id: string;
    workspaceId: string;
    createdAt: string;
    updatedAt: string;
  }>;
};

// ── Phase 2 expand: 环境 / 文件 / 观测 全量动词 ─────────────────────
//
// 以下类型与方法是 Phase 2 执行面搬家时扩入的契约面（设计文档 §4.2）。
// Phase 1 委托实现（RuntimeHostAdapter）以过渡方式兑现——
// 标注「过渡」的入参字段（runtimeHostId）在 Phase 2 per-Host 实例就绪后删除。

/**
 * Host 的能力矩阵动态部分：每种 isolation 的可用性 + CLI 检测结果。
 * 取代旧 RuntimeCapabilities（仅 isolationScopes 字符串数组）。
 */
export type HostCapabilityStatus = Record<
  Isolation,
  {
    available: boolean;
    /** 不可用原因，如 "docker daemon not running"。 */
    reason?: string;
    scopes: Array<WorkerScope>;
    /** native 才有：claude/codex 路径、版本、认证状态。 */
    cli?: AgentCliStatus;
  }
>;

/** agent CLI 环境检测结果（复用 RuntimeEnvConfig 形状）。 */
export type AgentCliStatus = RuntimeEnvConfig;

// ── 文件操作输入/输出类型 ──
//
// 过渡期入参带 runtimeHostId（Phase 2 per-Host 实例就绪后删除——
// Host 知道自己的 id，不需要调用方传入）。

export type ListDirectoryInput = {
  /** 过渡：Phase 2 per-Host 实例就绪后删除。 */
  runtimeHostId: string;
  path?: string;
};

export type DirectoryListing = {
  path: string;
  entries: string[];
};

export type CreateDirectoryInput = {
  /** 过渡：Phase 2 per-Host 实例就绪后删除。 */
  runtimeHostId: string;
  path: string;
};

export type WorkspaceFileQuery = {
  /** 过渡：Phase 2 per-Host 实例就绪后删除。 */
  runtimeHostId: string;
  rootPath: string;
  path: string;
};

export type ReadFileInput = {
  /** 过渡：Phase 2 per-Host 实例就绪后删除。 */
  runtimeHostId: string;
  rootPath: string;
  path: string;
};

export type ReadFileDiffInput = {
  /** 过渡：Phase 2 per-Host 实例就绪后删除。 */
  runtimeHostId: string;
  rootPath: string;
  path: string;
};

export type SearchFilesInput = {
  /** 过渡：Phase 2 per-Host 实例就绪后删除。 */
  runtimeHostId: string;
  rootPath: string;
};

export type ListChangedFilesInput = {
  /** 过渡：Phase 2 per-Host 实例就绪后删除。 */
  runtimeHostId: string;
  rootPath: string;
};

export type InstallCliInput = {
  /** 过渡：Phase 2 per-Host 实例就绪后删除。 */
  runtimeHostId: string;
  agentType: AgentType;
};

export type InstallCliResult = {
  envConfig: RuntimeEnvConfig;
};

/**
 * server → Runtime Host 的执行面契约。方向永远向下；Phase 1 由 worker-manager
 * 模块内的委托实现兑现（进程内），Phase 2 起 builtin 走库入口、registered 走隧道。
 */
export interface RuntimeHostContract {
  // —— 执行 ——

  /**
   * 提交一次 run：Host 负责取得/复用 worker、开会话、下发首条 user_message。
   * 幂等（runId 为键）；受理即返回，就绪/失败经 upstream 回流。
   */
  submitRun(input: SubmitRunInput): Promise<void>;

  /**
   * run 级命令（cancel / approval_resolved 等）。worker 就绪前到达的 cancel
   * 由 Host 内部吸收（就绪那刻转 cancelled 回流），调用方不需要感知时序。
   */
  command(runId: string, payload: CommandPayload): Promise<void>;

  // —— 业务级收尾 ——

  /**
   * owner 级释放：workspace 删除传 workspace:X，user 注销/禁用传 user:Y。
   * 幂等、可重试；目标键无 worker 时为空操作（见 §3.5 场景 4）。
   */
  releaseOwner(owner: OwnerKey): Promise<void>;

  // —— 环境 ——

  /**
   * 每种 isolation 的可用性 + CLI 检测结果，构成能力矩阵的动态部分。
   * 过渡：Phase 1 委托实现需 runtimeHostId 路由到正确的 Runtime；
   * Phase 2 per-Host 实例直接返回自身能力。
   */
  detectEnv(runtimeHostId: string): Promise<HostCapabilityStatus>;

  /** 安装 agent CLI（仅 native isolation 有意义）。 */
  installCli(input: InstallCliInput): Promise<InstallCliResult>;

  // —— 工作空间文件（数据面统一入口） ——

  /** 列出 path 下的子目录（不含文件）。path 省略时列出 Host 本机的用户主目录。 */
  listDirectory(input: ListDirectoryInput): Promise<DirectoryListing>;

  /** 在 path 下新建一个目录（含父级）。 */
  createDirectory(input: CreateDirectoryInput): Promise<void>;

  /** 列出 rootPath 下 relativePath 的文件列表。 */
  listFiles(input: WorkspaceFileQuery): Promise<WorkspaceFileListResponse>;

  /** 读取 rootPath 下 relativePath 的文件内容。 */
  readFile(input: ReadFileInput): Promise<WorkspaceFileReadResponse>;

  /** 读取 rootPath 下 relativePath 的 before/after diff。 */
  readFileDiff(input: ReadFileDiffInput): Promise<WorkspaceFileDiffResponse>;

  /** 列出 rootPath 下所有文件相对路径（git ls-files）。 */
  searchFiles(input: SearchFilesInput): Promise<WorkspaceFileSearchResponse>;

  /** 列出 rootPath 下相对 HEAD 的累计变更文件。 */
  listChangedFiles(input: ListChangedFilesInput): Promise<WorkspaceChangedFilesResponse>;

  // —— 观测（admin 诊断面，显式例外） ——

  /** 现场查询 Host 上的 worker 快照列表（不入库）。 */
  listWorkers(): Promise<WorkerSnapshot[]>;

  /** 按 WorkerKey 停止一个 worker（admin 诊断入口）。 */
  stopWorker(key: WorkerKey): Promise<void>;

  // —— 过渡成员（Phase 1 委托实现专用，Phase 2/3 收窄或删除） ——

  /** run 终态后的资源/索引清理。幂等，对未知 runId 是空操作。 */
  releaseRun(runId: string): void;

  /** 接线上行端口（启动期一次）。Phase 2 变为隧道会话注册的一部分。 */
  setUpstream(upstream: RuntimeHostUpstream): void;

  /**
   * 过渡（server 重启恢复）：按持久化的执行载体标识向仍存活的 worker 发 cancel。
   * Phase 2 后 server 重启不再打断 registered 上的 run，此动词收窄或删除。
   */
  sendRecoveryCancel(input: {
    runId: string;
    conversationId: string;
    ref: ExecutionRef;
  }): Promise<void>;

  /** 过渡（admin run 详情）：按执行载体标识取 worker 快照。Phase 2 起并入 listWorkers。 */
  getWorkerSnapshotForAdmin(ref: ExecutionRef): Promise<WorkerSnapshot | null>;
}

/**
 * Runtime Host → server 的唯一上行流。emit 走 per-run seq 闸门；notify* 是
 * Host 合成的终态/事实通知（无 seq，绕闸门——worker 从未启动或已异常消亡的场景，
 * 对应设计文档 §4.2 可靠性协议里 host-synthesized 一类）。
 */
export interface RuntimeHostUpstream {
  /** worker 事件流（带 seq，经去重闸门）。 */
  emit(runId: string, message: RunChannelMessage<unknown>): Promise<void>;

  /** 取实例失败 / worker 异常退出：run 转 error 终态。 */
  notifyRunFailed(runId: string, error: string): Promise<void>;

  /** 就绪前取消完成：run 转 cancelled 终态。 */
  notifyRunCancelled(runId: string): Promise<void>;

  /** worker 心跳超时被 fence 判死：记录事实并终结其名下 run。 */
  notifyWorkerLost(runId: string, reason: string): Promise<void>;

  /** 执行载体就绪（过渡）：供 run 行持久化 ExecutionRef 给 admin/恢复流程用。 */
  notifyExecutionRef(runId: string, ref: ExecutionRef): void;
}
