/** Paths to bundled Agent CLI executables, set by the desktop app's main process. */
export type AgentCliPaths = {
  claudeExecutablePath?: string;
  codexExecutablePath?: string;
};

/**
 * Reads AGEWORK_CLAUDE_CLI_PATH / AGEWORK_CODEX_CLI_PATH from the environment.
 * Used by the desktop app to point the SDKs at bundled CLI binaries instead of
 * the platform packages resolved from node_modules.
 */
export function resolveAgentCliPaths(
  env: Record<string, string | undefined>
): AgentCliPaths {
  const claudeExecutablePath = env.AGEWORK_CLAUDE_CLI_PATH?.trim() || undefined;
  const codexExecutablePath = env.AGEWORK_CODEX_CLI_PATH?.trim() || undefined;
  return { claudeExecutablePath, codexExecutablePath };
}
