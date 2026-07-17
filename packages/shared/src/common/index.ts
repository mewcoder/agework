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
export const AGENT_TYPES = ["claude", "codex", "opencode", "pi"] as const;
export type AgentType = (typeof AGENT_TYPES)[number];

export const AGENT_LABELS: Record<AgentType, string> = {
  claude: "Claude",
  codex: "Codex",
  opencode: "OpenCode",
  pi: "Pi",
};

/** agent 在工作空间目录下的配置目录前缀，用于定位 skills 等资源。 */
export const AGENT_DIR_PREFIX: Record<AgentType, string> = {
  claude: ".claude",
  codex: ".codex",
  opencode: ".opencode",
  pi: ".pi",
};

export function isAgentType(value: unknown): value is AgentType {
  return (
    typeof value === "string" &&
    AGENT_TYPES.includes(value as AgentType)
  );
}

/** 模型服务的 API 协议格式。provider 的固有属性是「说哪种协议」,支持哪些 agent 由此派生。 */
export const API_FORMATS = [
  "anthropic",
  "openai-responses",
  "openai-compatible",
] as const;
export type ApiFormat = (typeof API_FORMATS)[number];

export const API_FORMAT_LABELS: Record<ApiFormat, string> = {
  anthropic: "Anthropic Messages",
  "openai-responses": "OpenAI Responses API",
  "openai-compatible": "OpenAI Chat Completions",
};

/**
 * 每个 agent 自己声明消费哪些 API 格式(source of truth,格式→agent 的矩阵由此反查派生)。
 * `native` 是它的原生协议(「系统环境」虚拟 provider 展示用),必须包含在 `supported` 内。
 *
 * - claude(Claude Code)只认 Anthropic Messages。
 * - codex 原生 Responses(技术上可走 wire_api="chat" 消费 openai-compatible,产品上未放开)。
 * - opencode 三种都支持:按格式选 @ai-sdk/openai-compatible / @ai-sdk/openai / @ai-sdk/anthropic
 *   (见 opencode providers 文档,profile 里做包选择)。
 * - pi 三种都支持:models.json 的 api 枚举覆盖 anthropic-messages / openai-responses /
 *   openai-completions(见 pi docs/models.md,profile 里做映射)。
 */
export const AGENT_API_FORMAT_SUPPORT: Record<
  AgentType,
  { native: ApiFormat; supported: readonly ApiFormat[] }
> = {
  claude: { native: "anthropic", supported: ["anthropic"] },
  codex: { native: "openai-responses", supported: ["openai-responses"] },
  opencode: {
    native: "openai-compatible",
    supported: ["openai-compatible", "openai-responses", "anthropic"],
  },
  pi: {
    native: "anthropic",
    supported: ["anthropic", "openai-responses", "openai-compatible"],
  },
};

function agentTypesForFormat(format: ApiFormat): readonly AgentType[] {
  return AGENT_TYPES.filter((agentType) =>
    AGENT_API_FORMAT_SUPPORT[agentType].supported.includes(format)
  );
}

/** 派生:API 格式 → 可消费该格式的 agent。 */
export const API_FORMAT_AGENT_TYPES: Record<ApiFormat, readonly AgentType[]> =
  {
    anthropic: agentTypesForFormat("anthropic"),
    "openai-responses": agentTypesForFormat("openai-responses"),
    "openai-compatible": agentTypesForFormat("openai-compatible"),
  };

/** 派生:agent 各自的原生 API 格式。 */
export const AGENT_NATIVE_API_FORMAT: Record<AgentType, ApiFormat> = {
  claude: AGENT_API_FORMAT_SUPPORT.claude.native,
  codex: AGENT_API_FORMAT_SUPPORT.codex.native,
  opencode: AGENT_API_FORMAT_SUPPORT.opencode.native,
  pi: AGENT_API_FORMAT_SUPPORT.pi.native,
};

export function isApiFormat(value: unknown): value is ApiFormat {
  return (
    typeof value === "string" && API_FORMATS.includes(value as ApiFormat)
  );
}

/** 某 agent 声明消费的全部 API 格式。 */
export function apiFormatsForAgent(agentType: AgentType): ApiFormat[] {
  return [...AGENT_API_FORMAT_SUPPORT[agentType].supported];
}

/** 检测到的单个 agent CLI 环境信息（上报层，不可被 admin 直接覆写）。 */
export type AgentDetectedEnv = {
  /** 检测到的可执行文件绝对路径；没找到为 null。 */
  executablePath: string | null;
  /** CLI --version 输出；取不到为 null。 */
  version: string | null;
};

/** 一台执行机上报的完整 CLI 环境配置——每个 agent 一条（生产者:cli/cli-resolver）。 */
export type RuntimeEnvConfig = {
  claude: AgentDetectedEnv;
  codex: AgentDetectedEnv;
  opencode: AgentDetectedEnv;
  pi: AgentDetectedEnv;
  /** 检测时间戳（ISO 8601），供前端判断新鲜度。 */
  detectedAt: string;
};

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
