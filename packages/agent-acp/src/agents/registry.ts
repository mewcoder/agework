import type { AcpAgentProfile } from "./types";
import { openCodeAcpProfile } from "./opencode";
import { piAcpProfile } from "./pi";

const PROFILES: ReadonlyMap<string, AcpAgentProfile> = new Map([
  [openCodeAcpProfile.agentType, openCodeAcpProfile],
  [piAcpProfile.agentType, piAcpProfile],
]);

/** Look up the ACP profile for an agentType, or undefined if it is not ACP-backed. */
export function getAcpProfile(agentType: string): AcpAgentProfile | undefined {
  return PROFILES.get(agentType);
}

/** Whether the given agentType is served by a generic ACP profile. */
export function isAcpAgent(agentType: string): boolean {
  return PROFILES.has(agentType);
}

/** Snapshot of bundled profiles for plugin manifest registration. */
export function listAcpProfiles(): AcpAgentProfile[] {
  return [...PROFILES.values()];
}
