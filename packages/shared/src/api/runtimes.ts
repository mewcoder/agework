import type { RuntimeCapabilities } from "../protocol/runtime-capabilities";
import type { AgentType } from "../common";

export type RuntimeStatus = "online" | "offline";

// ── EnvConfig 类型（见 runtime 模块 ADR-0002 两层分离）──────────────────

/** Runtime manager 检测到的单个 agent CLI 环境信息（上报层，不可被 admin 直接覆写）。 */
export type AgentDetectedEnv = {
  /** 检测到的可执行文件绝对路径；没找到为 null。 */
  executablePath: string | null;
  /** CLI --version 输出；取不到为 null。 */
  version: string | null;
};

/** 一个 Runtime 上报的完整环境配置——每个 agent 一条。 */
export type RuntimeEnvConfig = {
  claude: AgentDetectedEnv;
  codex: AgentDetectedEnv;
  opencode: AgentDetectedEnv;
  /** 检测时间戳（ISO 8601），供前端判断新鲜度。 */
  detectedAt: string;
};

/** 管理员手动覆盖的 CLI 路径，与 envConfig 独立存储（见 ADR-0002）。per-runtime per-agent 粒度。 */
export type RuntimeEnvConfigOverride = {
  claude?: { executablePath: string };
  codex?: { executablePath: string };
  opencode?: { executablePath: string };
};

/** resolved CLI path 的来源标记，实时派生不持久化（见 ADR-0002）。 */
export type EnvConfigSource = "system" | "custom";

/** 单个 agent 的展示层派生结果（override + detected 合并后，不存 DB）。 */
export type AgentEnvStatus = {
  /** 最终生效路径：override ?? detected ?? null。 */
  resolvedPath: string | null;
  /** 路径来源：override 有值 → "custom"，否则 → "system"。resolvedPath 为 null 时仍为 "system"。 */
  source: EnvConfigSource;
  /** runtime 上报的原始检测路径。 */
  detectedPath: string | null;
  /** CLI --version 输出。 */
  version: string | null;
};

/** Runtime 展示层 env 状态（claude + codex 各一条派生结果）。 */
export type RuntimeEnvStatus = {
  claude: AgentEnvStatus;
  codex: AgentEnvStatus;
  opencode: AgentEnvStatus;
  /** 检测时间戳（ISO 8601）。 */
  detectedAt: string | null;
};

/** /api/v1/runtimes/list 的条目（builtin 本机 Host + registered 远程 Host）。 */
export type RuntimeResponse = {
  id: string;
  name: string;
  /** "registered"=远程机器注册, "builtin"=本机内置(全局,不可删除)。 */
  source: string;
  /** null = 全局 builtin,所有人可用;有值 = 私有 registered,只有该用户可见/可删。 */
  ownerId: string | null;
  status: RuntimeStatus;
  capabilities: RuntimeCapabilities | null;
  /** runtime manager 上报的环境检测原始值；未上报为 null。 */
  envConfig: RuntimeEnvConfig | null;
  /** 管理员覆盖；未覆盖为 null。 */
  envConfigOverride: RuntimeEnvConfigOverride | null;
  /** override + detected 合并后的展示层派生结果；envConfig 为 null 时整体为 null。 */
  envStatus: RuntimeEnvStatus | null;
  /** ISO 8601 */
  lastHeartbeatAt: string | null;
  /** ISO 8601 */
  createdAt: string;
};

export type CreateRuntimeRequest = {
  name: string;
};

/** 创建响应:配对 token 明文只在这里出现一次,之后不可再取。 */
export type CreateRuntimeResponse = {
  runtime: RuntimeResponse;
  token: string;
};

export type RuntimeIdRequest = { id: string };

/** admin 覆盖 envConfig 的请求 body：per-agent，只覆盖指定的 agent。 */
export type UpdateEnvConfigOverrideRequest = {
  /** 目标 runtime id。 */
  id: string;
  /** 指定要覆盖的 agent。 */
  agentType: AgentType;
  /** 覆盖路径；空字符串 = 清除该 agent 的覆盖。 */
  executablePath: string;
};

/** admin 触发 runtime 重检 envConfig 的响应。 */
export type DetectEnvResponse = {
  /** 重检后的 envConfig；runtime 未连接时为 null。 */
  envConfig: RuntimeEnvConfig | null;
};

/** admin 一键安装 runtime 独立 CLI 的请求 body：per-agent，仅支持 native runtime。 */
export type InstallCliRequest = {
  /** 目标 runtime id。 */
  id: string;
  /** 指定要安装的 agent。 */
  agentType: AgentType;
};

/** GET /api/v1/runtimes/directories/list 的查询参数。 */
export type ListRuntimeDirectoryRequest = {
  /** 目标 runtime id。 */
  runtimeId: string;
  /** 省略时列出该 runtime 所在机器的用户主目录。 */
  path?: string;
};

/** 目录浏览响应:path 为浏览到的绝对路径,list 为其下子目录的完整绝对路径(不含文件)。 */
export type RuntimeDirectoryResponse = {
  path: string;
  list: string[];
};

/** POST /api/v1/runtimes/directories/create 的请求 body。 */
export type CreateRuntimeDirectoryRequest = {
  /** 目标 runtime id。 */
  runtimeId: string;
  /** 要新建的目录绝对路径。 */
  path: string;
};

/** 新建目录响应,path 为新建目录的绝对路径。 */
export type CreateRuntimeDirectoryResponse = {
  path: string;
};
