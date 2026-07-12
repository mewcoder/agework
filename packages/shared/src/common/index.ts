import { v7 } from "uuid";

/**
 * agework 全局版本号,内联在本入口文件(原因同 generateId:shared 以源码形式被
 * 消费,跨文件 re-export 值会 ERR_MODULE_NOT_FOUND)。worker/manager 在 register
 * 握手时带上自己的值,server 比对自己的值:不一致只告警+放行,不阻断(主要兜底
 * Registered 远程 manager 单独构建后与 server 版本漂移的情形)。每次发版手动 bump。
 */
export const AGEWORK_VERSION = "0.0.1";

/**
 * 生成 UUID v7(时序有序)。前后端统一 id 入口。
 *
 * 选 v7 而非 v4:PG 原生 uuid 类型(16字节)+ 时序有序(id 排序=创建序)+ B-tree 写入局部性。
 *
 * 注意:本函数为运行时值导出,必须内联在本入口文件中,不可跨文件 re-export ——
 * shared 包以源码形式被消费(exports 指向 src 源文件,无 dist),NodeNext 运行时
 * 解析跨文件 re-export 需要显式扩展名,而磁盘上是 .ts,会导致 ERR_MODULE_NOT_FOUND。
 */
export function generateId(): string {
  return v7();
}

/** 支持的 agent 类型。 */
export const AGENT_TYPES = ["claude", "codex"] as const;
export type AgentType = (typeof AGENT_TYPES)[number];

export const AGENT_LABELS: Record<AgentType, string> = {
  claude: "Claude",
  codex: "Codex",
};

/** agent 在工作空间目录下的配置目录前缀，用于定位 skills 等资源。 */
export const AGENT_DIR_PREFIX: Record<AgentType, string> = {
  claude: ".claude",
  codex: ".codex",
};

export function isAgentType(value: unknown): value is AgentType {
  return (
    typeof value === "string" &&
    AGENT_TYPES.includes(value as AgentType)
  );
}

/** worker run 的生命周期状态。 */
export type RunStatus =
  | "queued"
  | "preparing"
  | "running"
  | "requires_action"
  | "cancelling"
  | "finished"
  | "error"
  | "cancelled";

/**
 * run 终态集合的唯一定义。server 状态机、worker 收尾、runner 清理都从这里取,
 * 不允许在任何一端再手写 finished|error|cancelled 集合。
 */
export const TERMINAL_RUN_STATUSES = [
  "finished",
  "error",
  "cancelled",
] as const;

export type TerminalRunStatus = (typeof TERMINAL_RUN_STATUSES)[number];

export function isTerminalRunStatus(
  status: RunStatus,
): status is TerminalRunStatus {
  return (TERMINAL_RUN_STATUSES as readonly RunStatus[]).includes(status);
}

/** Run/Conversation 等待人工操作时标记的动作类型。 */
export type PendingAction = "question" | null;

/** 接口统一信封响应。 */
export type ApiResponse<T> = {
  code: number;
  data: T;
  message: string;
};

/** 非分页列表响应。 */
export type ListResponse<T> = {
  list: T[];
  total?: number;
};

/** 分页列表响应。 */
export type PaginatedListResponse<T> = {
  list: T[];
  total: number;
  pageNo: number;
  pageSize: number;
};
