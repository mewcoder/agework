import type { AgentProviderConfig, CommandPayload } from "./channel";
import type { RunChannelMessage } from "./run-channel-message";

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

export function workspaceOwnerKey(workspaceId: string): OwnerKey {
  return `workspace:${workspaceId}`;
}

export function userOwnerKey(userId: string): OwnerKey {
  return `user:${userId}`;
}

export function workerKey(owner: OwnerKey, isolation: Isolation): WorkerKey {
  return `${owner}#${isolation}`;
}

/** 拆 owner 键。仅接受本文件构造器产出的形状，坏输入直接抛错（编程错误，不兜）。 */
export function parseOwnerKey(owner: OwnerKey): {
  scope: WorkerScope;
  id: string;
} {
  const sep = owner.indexOf(":");
  const scope = owner.slice(0, sep);
  const id = owner.slice(sep + 1);
  if ((scope !== "workspace" && scope !== "user") || !id) {
    throw new Error(`invalid owner key: ${owner}`);
  }
  return { scope, id };
}

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

/**
 * server → Runtime Host 的执行面契约。方向永远向下；Phase 1 由 worker-manager
 * 模块内的委托实现兑现（进程内），Phase 2 起 builtin 走库入口、registered 走隧道。
 */
export interface RuntimeHostContract {
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
