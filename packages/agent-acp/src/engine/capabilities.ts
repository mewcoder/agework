import type { InitializeResponse } from "@agentclientprotocol/sdk";

/**
 * Normalized snapshot of an agent's advertised capabilities. Downstream logic
 * branches on these booleans instead of poking at the raw `agentCapabilities`
 * shape, and unknown/experimental fields stay out of business decisions (they
 * remain in the raw trace).
 */
export type AcpNormalizedCapabilities = {
  protocolVersion: number;
  loadSession: boolean;
  resumeSession: boolean;
  closeSession: boolean;
  listSessions: boolean;
  deleteSession: boolean;
  forkSession: boolean;
  promptCapabilities: {
    image: boolean;
    audio: boolean;
    embeddedContext: boolean;
  };
  mcpHttp: boolean;
  mcpSse: boolean;
};

/** A capability advertised as `{}` (supported) vs `null`/omitted (unsupported). */
function has(value: unknown): boolean {
  return value != null;
}

/** Derive an {@link AcpNormalizedCapabilities} from an `initialize` response. */
export function normalizeCapabilities(
  response: InitializeResponse
): AcpNormalizedCapabilities {
  const caps = response.agentCapabilities ?? {};
  const session = caps.sessionCapabilities ?? {};
  const prompt = caps.promptCapabilities ?? {};
  const mcp = caps.mcpCapabilities ?? {};

  return {
    protocolVersion: response.protocolVersion,
    loadSession: caps.loadSession === true,
    resumeSession: has(session.resume),
    closeSession: has(session.close),
    listSessions: has(session.list),
    deleteSession: has(session.delete),
    forkSession: has(session.fork),
    promptCapabilities: {
      image: prompt.image === true,
      audio: prompt.audio === true,
      embeddedContext: prompt.embeddedContext === true,
    },
    mcpHttp: mcp.http === true,
    mcpSse: mcp.sse === true,
  };
}
