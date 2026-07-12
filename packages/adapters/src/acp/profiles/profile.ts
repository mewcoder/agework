/** Inputs a profile uses to build the agent subprocess environment. */
export type AcpProfileEnvInput = {
  /** `system` = use the agent's own local auth/config; `custom` = AgeWork-provided provider. */
  source: "system" | "custom";
  /** Safe base environment (worker/server private vars already stripped). */
  baseEnv: Record<string, string>;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  /** Whitelisted per-profile overrides (never spread raw). */
  extraConfig?: Record<string, string>;
};

/**
 * Describes how to launch and configure one concrete ACP agent. It only knows
 * command/args/binary and environment — no protocol logic, spawning, session
 * lifecycle, or AG-UI mapping (doc §7).
 */
export interface AcpAgentProfile {
  /** AgeWork agentType this profile serves (e.g. "opencode"). */
  agentType: string;
  displayName: string;
  /** Default command (overridden by a resolved executable path at launch). */
  command: string;
  args: readonly string[];
  /** npm package that provides the CLI (for runtime install). */
  npmPackage?: string;
  binaryName: string;
  /** Build the child environment for a run. */
  buildEnv(input: AcpProfileEnvInput): Record<string, string>;
}
