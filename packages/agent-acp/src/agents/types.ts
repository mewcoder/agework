/** Inputs a profile uses to build the agent subprocess environment. */
export type AcpProfileEnvInput = {
  /** `system` = use the agent's own local auth/config; `custom` = AgeWork-provided provider. */
  source: "system" | "custom";
  /** Safe base environment (worker/server private vars already stripped). */
  baseEnv: Record<string, string>;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  /** ModelProvider 的 API 协议格式(如 "openai-responses"),profile 据此选接入方式。 */
  apiFormat?: string;
  /** Whitelisted per-profile overrides (never spread raw). */
  extraConfig?: Record<string, string>;
  /** 本次 run 的权限预设(agent-options 声明的 value);profile 自行映射,无声明的 agent 忽略。 */
  permissionMode?: string;
};

/**
 * Describes how to launch and configure one concrete ACP agent. It only knows
 * command/args/binary and environment — no protocol logic, spawning, session
 * lifecycle, or AG-UI mapping; those stay in the shared engine and bridge layers.
 */
export interface AcpAgentProfile {
  /** AgeWork agentType this profile serves (e.g. "opencode"). */
  agentType: string;
  displayName: string;
  /** Default command (overridden by a resolved executable path at launch). */
  command: string;
  args: readonly string[];
  /** Build the child environment for a run. */
  buildEnv(input: AcpProfileEnvInput): Record<string, string>;
  /**
   * 可选:由 resolved CLI 路径推导实际 spawn 目标。桥接型 agent(如 pi 经 pi-acp)
   * 的 resolved 路径是 agent 本体而非要 spawn 的进程,profile 在此把它换成桥命令
   * 并经 env 转交。缺省行为:spawn `executablePath ?? command`。
   */
  resolveLaunch?(executablePath?: string): {
    command: string;
    args: readonly string[];
    env: Record<string, string>;
  };
}
