// 系统环境模式额外透传 Claude 认证变量。
const CLAUDE_ENV_KEYS = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MODEL",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_SECURESTORAGE_CONFIG_DIR",
]);

/**
 * Agent 作为本机进程运行时继承系统环境，但不能继承 AgeWork 宿主私密变量
 * 和内部协议变量。自定义 Claude 配置模式下额外剔除 Claude 系统认证变量，
 * 避免覆盖当前 run 明确传入的 provider 配置。
 */
export function pickSafeEnv(options: {
  includeClaudeEnv: boolean;
}): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("AGEWORK_PRIVATE_")) continue;
    if (key.startsWith("AGEWORK_INTERNAL_")) continue;
    if (!options.includeClaudeEnv && CLAUDE_ENV_KEYS.has(key)) continue;
    result[key] = value;
  }
  return result;
}
