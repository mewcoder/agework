import type { AgentTraceSink } from "@agework/shared/protocol";
import { pickSafeEnv } from "../../common/safe-env";
import type { AcpAgentProfile } from "../profiles/profile";
import { AcpAgentAdapter, type AcpPendingAction } from "./acp-agent.adapter";

export type CreateAcpAdapterOptions = {
  /** `system` = agent's own auth/config; `custom` = AgeWork provider credentials. */
  source: "system" | "custom";
  /** Runtime workspace path (process cwd + ACP session cwd). */
  cwd: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  /** ModelProvider 的 API 协议格式,透传给 profile 选接入方式。 */
  apiFormat?: string;
  extraConfig?: Record<string, string>;
  /** Resolved agent CLI path (overrides the profile's default command). */
  executablePath?: string;
  trace?: AgentTraceSink;
  pendingActionSink?: (event: {
    threadId: string;
    pendingAction: AcpPendingAction;
  }) => void;
  permissionTimeoutMs?: number;
};

/** Drop undefined values so the child env is a strict string map. */
function cleanEnv(env: Record<string, string | undefined>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") result[key] = value;
  }
  return result;
}

/**
 * Assemble an {@link AcpAgentAdapter} from a profile plus this run's credentials.
 * The profile owns environment/config shaping; everything protocol-related is
 * profile-agnostic.
 */
export function createAcpAdapter(
  profile: AcpAgentProfile,
  opts: CreateAcpAdapterOptions
): AcpAgentAdapter {
  const baseEnv = cleanEnv(pickSafeEnv({ includeClaudeEnv: false }));
  const env = profile.buildEnv({
    source: opts.source,
    baseEnv,
    apiKey: opts.apiKey,
    baseUrl: opts.baseUrl,
    model: opts.model,
    apiFormat: opts.apiFormat,
    extraConfig: opts.extraConfig,
  });

  // 桥接型 profile(如 pi 经 pi-acp)自定 spawn 目标;缺省 spawn resolved 路径或默认命令。
  const launch = profile.resolveLaunch?.(opts.executablePath);

  return new AcpAgentAdapter({
    command: launch?.command ?? opts.executablePath ?? profile.command,
    args: launch ? [...launch.args] : [...profile.args],
    cwd: opts.cwd,
    env: launch ? { ...env, ...launch.env } : env,
    agentType: profile.agentType,
    trace: opts.trace,
    pendingActionSink: opts.pendingActionSink,
    permissionTimeoutMs: opts.permissionTimeoutMs,
  });
}
