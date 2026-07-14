import type { RuntimeCapabilities } from "../protocol/runtime-capabilities";
import type { AgentType, RuntimeEnvConfig } from "../common";

export type RuntimeHostStatus = "online" | "offline";

// ── EnvConfig 类型（见 runtime 模块 ADR-0002 两层分离）──────────────────
//
// 上报层类型定义在 common（生产者是 cli/cli-resolver），此处 re-export 供 REST 消费方使用。

export type { AgentDetectedEnv, RuntimeEnvConfig } from "../common";

/** 管理员手动覆盖的 CLI 路径，与 envConfig 独立存储（见 ADR-0002）。per-runtime per-agent 粒度。 */
export type RuntimeHostEnvConfigOverride = {
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
export type RuntimeHostEnvStatus = {
  claude: AgentEnvStatus;
  codex: AgentEnvStatus;
  opencode: AgentEnvStatus;
  /** 检测时间戳（ISO 8601）。 */
  detectedAt: string | null;
};

/** /api/v1/runtime-hosts/list 的条目（builtin 本机 Host + registered 远程 Host）。 */
export type RuntimeHostResponse = {
  id: string;
  name: string;
  /** "registered"=远程机器注册, "builtin"=本机内置(全局,不可删除)。 */
  source: string;
  /** null = 全局 builtin,所有人可用;有值 = 私有 registered,只有该用户可见/可删。 */
  ownerId: string | null;
  status: RuntimeHostStatus;
  capabilities: RuntimeCapabilities | null;
  /** runtime manager 上报的环境检测原始值；未上报为 null。 */
  envConfig: RuntimeEnvConfig | null;
  /** 管理员覆盖；未覆盖为 null。 */
  envConfigOverride: RuntimeHostEnvConfigOverride | null;
  /** override + detected 合并后的展示层派生结果；envConfig 为 null 时整体为 null。 */
  envStatus: RuntimeHostEnvStatus | null;
  /** ISO 8601 */
  lastHeartbeatAt: string | null;
  /** ISO 8601 */
  createdAt: string;
};

export type CreateRuntimeHostRequest = {
  name: string;
};

/** 创建响应:配对 token 明文只在这里出现一次,之后不可再取。 */
export type CreateRuntimeHostResponse = {
  runtimeHost: RuntimeHostResponse;
  token: string;
};

export type RuntimeHostIdRequest = { id: string };

/** admin 覆盖 envConfig 的请求 body：per-agent，只覆盖指定的 agent。 */
export type UpdateEnvConfigOverrideRequest = {
  /** 目标 Runtime Host id。 */
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
  /** 目标 Runtime Host id。 */
  id: string;
  /** 指定要安装的 agent。 */
  agentType: AgentType;
};

/** GET /api/v1/runtime-hosts/directories/list 的查询参数。 */
export type ListHostDirectoryRequest = {
  /** 目标 Runtime Host id。 */
  runtimeHostId: string;
  /** 省略时列出该 Host 所在机器的用户主目录。 */
  path?: string;
};

/** 目录浏览响应:path 为浏览到的绝对路径,list 为其下子目录的完整绝对路径(不含文件)。 */
export type HostDirectoryResponse = {
  path: string;
  list: string[];
};

/** POST /api/v1/runtime-hosts/directories/create 的请求 body。 */
export type CreateHostDirectoryRequest = {
  /** 目标 Runtime Host id。 */
  runtimeHostId: string;
  /** 要新建的目录绝对路径。 */
  path: string;
};

/** 新建目录响应,path 为新建目录的绝对路径。 */
export type CreateHostDirectoryResponse = {
  path: string;
};
