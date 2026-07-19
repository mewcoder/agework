const AGENT_AUTH_ENV_KEYS = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MODEL",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_SECURESTORAGE_CONFIG_DIR",
]);

/** ACP child processes inherit ordinary user env, never Host/Worker secrets or
 * another agent's ambient credentials. Profiles add their explicit config later. */
export function pickSafeEnv(): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("AGEWORK_PRIVATE_")) continue;
    if (key.startsWith("AGEWORK_WORKER_")) continue;
    if (AGENT_AUTH_ENV_KEYS.has(key)) continue;
    result[key] = value;
  }
  return result;
}
