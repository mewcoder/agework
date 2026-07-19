import type {
  AgentProviderConfig,
  CommandPayload,
  WorkerScope,
} from "./channel";
import type { RunChannelMessage } from "./run-channel-message";
import type { AgentType, RuntimeEnvConfig } from "../common";
import type {
  FileEntry,
  ChangedFileEntry,
  WorkspaceChangeStatus,
} from "../filesystem/types";

// ── Server ↔ Runtime Host 契约 ──────────────────────────────────────
//
// 设计定案见 .scratch/runtime-owner-boundary/SPEC.md。
// Server 只下发 scope 与业务身份事实,Runtime 是复用身份与复用策略的唯一权威。

/** Runtime SDK 插件声明的开放标识，如 native / docker / opensandbox。 */
export type RuntimeType = string;

/**
 * 一次 run 的放置决策：Server 把业务事实(scope + userId + workspaceId +
 * userLifecycleVersion)交给 Runtime,Runtime 从中派生隔离与复用身份。
 * Host 不解引用任何业务数据(workspaceId/userId 对 Host 是不透明的路由/复用/
 * 收尾键,见不变量 7),但需要 username / workspacePath 派生执行机路径。
 */
export type RunPlacement = {
  /** 最大共享边界,始终存在;native 也是 "workspace"。 */
  scope: "workspace" | "user";
  runtimeType: RuntimeType;
  runtimeHostId: string;
  workspaceId: string;
  userId: string;
  /** DB User.sessionVersion;可逆 user 生命周期的 execution generation。 */
  userLifecycleVersion: number;
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

/** Server → Runtime Host 的 run 级命令。runtimeHostId 只用于 server 路由。 */
export type RuntimeHostCommandInput = {
  runtimeHostId: string;
  payload: CommandPayload;
};
/** run 终态后的 Host 内部状态清理路由。 */
export type RuntimeHostRunRef = {
  runtimeHostId: string;
  runId: string;
};

// ── 资源生命周期 ──────────────────────────────────────────────────────

/** Runtime 收尾的业务主体:workspace 或 user。 */
export type RuntimeLifecycleTarget =
  | { type: "workspace"; workspaceId: string }
  | { type: "user"; userId: string };

/**
 * 资源释放的定向路由输入。
 * - workspace target:取消/fence 该 workspace 已受理的 submission 和 run;只释放
 *   workspace-scope worker;user-scope 共享 worker 继续服务同用户其他 workspace。
 * - user target:fence 该 user 中 userLifecycleVersion <= target version 的
 *   submission、acquisition 和 worker;释放该代及旧代的两类 scope worker。
 * - 成功 ACK 是完成屏障。
 */
export type ReleaseRuntimeResourcesInput =
  | {
      runtimeHostId: string;
      target: { type: "workspace"; workspaceId: string };
    }
  | {
      runtimeHostId: string;
      target: {
        type: "user";
        userId: string;
        /** 必填,来源为状态写入后返回的 User.sessionVersion。 */
        userLifecycleVersion: number;
      };
    };

/** Host 上资源生命周期(替代旧 releaseOwner)。 */
export interface RuntimeHostResourceLifecycle {
  releaseResources(input: ReleaseRuntimeResourcesInput): Promise<void>;
}

/** stopWorker 的定向路由输入;admin 诊断面按 host+workerId 精确停止。 */
export type StopWorkerInput = {
  /** 目标 Host。 */
  runtimeHostId: string;
  /** Runtime 内部控制身份。 */
  workerId: string;
};

/**
 * admin 观测用的 worker 快照(诊断面显式例外,业务代码禁止消费)。
 * 形状即 Host 内存池条目(WorkerEntry)的直投影。只表达现场事实,不能作为业务
 * 生命周期命令输入。
 */
export type WorkerSnapshot = {
  /** 所在 Host。Host 本地不知道自己的注册 id，置空串，由 server 路由层盖章。 */
  runtimeHostId: string;
  workerId: string;
  runtimeType: string;
  /** 结构化隔离身份,由 Runtime 从 placement 唯一派生。 */
  isolation: {
    scope: "workspace" | "user";
    subjectId: string;
  };
  userId: string;
  /** 仅供 admin 现场诊断关联 run，不持久化到 server。 */
  runIds: string[];
  runtimeInstanceId: string;
  status: "starting" | "ready";
  /** 最后一次心跳/事件上报时间（ISO）。 */
  lastSeenAt: string;
};

// ── 业务生命周期 claims 投影(重连对账) ────────────────────────────────

/**
 * Runtime Host 的业务生命周期 claims 投影,供 Server 重连对账。
 * 必须覆盖尚未形成 ready worker 的状态,不能只返回 worker 复用主体。
 */
export type RuntimeLifecycleClaim =
  | {
      kind: "session";
      runtimeHostId: string;
      runId: string;
      phase: "reserved" | "configuring" | "acquiring" | "ready";
      userId: string;
      userLifecycleVersion: number;
      workspaceId: string;
    }
  | {
      kind: "worker";
      runtimeHostId: string;
      workerId: string;
      scope: "workspace" | "user";
      subjectId: string;
      userId: string;
      userLifecycleVersion: number;
      workspaceIds: string[];
    }
  | {
      kind: "release_pending";
      runtimeHostId: string;
      target: RuntimeLifecycleTarget;
      userLifecycleVersion?: number;
    };

/** Server 重连对账使用的资源 reconciliation 端口。 */
export interface RuntimeHostResourceReconciliation {
  /** 查询目标 Host 的业务生命周期 claims。查询失败必须显式失败,不能折叠为空列表。 */
  listLifecycleClaims(runtimeHostId: string): Promise<RuntimeLifecycleClaim[]>;
  releaseResources(input: ReleaseRuntimeResourcesInput): Promise<void>;
}

// ── 环境 / 文件 / 观测动词 ─────────────────────────────────────────
//
// RuntimeHostAdapter 使用 runtimeHostId 选择 builtin 或 registered Host；
// Host 的具体执行能力由 runtimeType 显式表达。

/**
 * Host 的能力矩阵动态部分：每种 runtimeType 的可用性 + CLI 检测结果。
 */
export type HostCapabilityStatus = Record<
  RuntimeType,
  {
    available: boolean;
    /** Runtime Host 或插件 manifest 提供的展示名。 */
    displayName?: string;
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
// runtimeHostId 是 server 侧路由选择器，和 runtimeType（执行能力）正交。

export type ListDirectoryInput = {
  /** 目标 Host。 */
  runtimeHostId: string;
  path?: string;
};

export type DirectoryListing = {
  path: string;
  entries: string[];
};

export type CreateDirectoryInput = {
  /** 目标 Host。 */
  runtimeHostId: string;
  path: string;
};

export type WorkspaceFileQuery = {
  /** 目标 Host。 */
  runtimeHostId: string;
  rootPath: string;
  path: string;
};

export type ReadFileInput = {
  /** 目标 Host。 */
  runtimeHostId: string;
  rootPath: string;
  path: string;
};

export type ReadFileDiffInput = {
  /** 目标 Host。 */
  runtimeHostId: string;
  rootPath: string;
  path: string;
};

export type SearchFilesInput = {
  /** 目标 Host。 */
  runtimeHostId: string;
  rootPath: string;
};

export type ListChangedFilesInput = {
  /** 目标 Host。 */
  runtimeHostId: string;
  rootPath: string;
};

// ── 文件操作结果类型 ──
//
// 定义在契约层（Host 是生产者），api 层 re-export 作为对应 REST 端点的响应形状。

export type WorkspaceFileListResponse = {
  path: string;
  list: FileEntry[];
  truncated: boolean;
};

export type WorkspaceFileReadResponse = {
  path: string;
  encoding: "utf8" | "base64";
  content: string;
  size: number;
  truncated: boolean;
};

/** 文件相对路径检索结果。list 为相对路径数组。 */
export type WorkspaceFileSearchResponse = {
  list: string[];
  truncated: boolean;
};

/** 相对 HEAD 的累计变更文件列表。 */
export type WorkspaceChangedFilesResponse = {
  list: ChangedFileEntry[];
  truncated: boolean;
};

/** 单文件 before/after diff。before/after 为 null 表示新增/删除侧不存在。 */
export type WorkspaceFileDiffResponse = {
  path: string;
  status: WorkspaceChangeStatus;
  before: string | null;
  after: string | null;
};

export type InstallCliInput = {
  /** 目标 Host。 */
  runtimeHostId: string;
  agentType: AgentType;
};

export type InstallCliResult = {
  /** 装好后的可执行文件绝对路径;持久化为 envConfigOverride 是 server 的事。 */
  executablePath: string;
};

/** run 模块唯一应依赖的执行面。 */
export interface RuntimeHostExecution {
  /**
   * 提交一次 run：Host 负责取得/复用 worker、开会话、下发首条 user_message。
   * 幂等（runId 为键）；受理即返回，就绪/失败经 upstream 回流。
   */
  submitRun(input: SubmitRunInput): Promise<void>;

  /**
   * run 级命令（cancel / approval_resolved 等）。worker 就绪前到达的 cancel
   * 由 Host 内部吸收（就绪那刻转 cancelled 回流），调用方不需要感知时序。
   */
  command(input: RuntimeHostCommandInput): Promise<void>;

  /** run 终态后的资源/索引清理。幂等，对未知 runId 是空操作。 */
  releaseRun(input: RuntimeHostRunRef): void;
}

/** 仅供组合根在启动期把 Host 上行流接回 server；业务执行消费者不得依赖。 */
export interface RuntimeHostUpstreamBinding {
  /** 接线上行端口（启动期一次）。 */
  setUpstream(upstream: RuntimeHostUpstream): void;
}

/** Host 本机环境与 CLI 能力。 */
export interface RuntimeHostEnvironment {
  /** 每种 runtimeType 的可用性 + CLI 检测结果，构成目标 Host 的能力矩阵。 */
  detectEnv(runtimeHostId: string): Promise<HostCapabilityStatus>;

  /** 在目标 Host 上安装 agent CLI(仅 native runtimeType 有意义),返回可执行路径。 */
  installCli(input: InstallCliInput): Promise<InstallCliResult>;
}

/** Host 上工作空间文件与 Git 数据面。 */
export interface RuntimeHostWorkspaceData {
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
  listChangedFiles(
    input: ListChangedFilesInput
  ): Promise<WorkspaceChangedFilesResponse>;
}

/** admin / reconciliation 显式使用的现场诊断面。业务执行不得依赖。 */
export interface RuntimeHostDiagnostics {
  /** 现场查询 Host 上的 worker 快照列表（不入库）。 */
  listWorkers(): Promise<WorkerSnapshot[]>;

  /** Host 现场 run 会话清单（含尚未绑定 Worker 的 acquiring），恢复对账用。 */
  listRunIds(runtimeHostId: string): Promise<string[]>;

  /**
   * 业务生命周期 claims 投影(重连对账用)。
   * 必须覆盖尚未形成 ready worker 的状态,不能只返回 worker 复用主体。
   * 查询失败必须显式失败,不能折叠为空列表。
   */
  listLifecycleClaims(): Promise<RuntimeLifecycleClaim[]>;

  /** 按 runtimeHostId 定向停止目标 Host 上的一个 worker（admin 诊断入口）。 */
  stopWorker(input: StopWorkerInput): Promise<void>;
}

/**
 * Host 实现/路由适配器的完整组合契约。消费者应优先注入上面的最小角色。
 * 方向永远向下；builtin 走进程内调用，registered 走控制隧道。
 */
export interface RuntimeHostContract
  extends
    RuntimeHostExecution,
    RuntimeHostUpstreamBinding,
    RuntimeHostResourceLifecycle,
    RuntimeHostEnvironment,
    RuntimeHostWorkspaceData,
    RuntimeHostDiagnostics {}

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
}
