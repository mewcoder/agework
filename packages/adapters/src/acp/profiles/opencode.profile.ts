import type { AcpAgentProfile, AcpProfileEnvInput } from "./profile";

const OPENCODE_PROVIDER = "_agework";

/** ModelProvider 的 apiFormat → OpenCode provider npm 包(见 opencode providers 文档)。 */
function resolveProviderNpm(apiFormat?: string): string {
  if (apiFormat === "anthropic") return "@ai-sdk/anthropic";
  if (apiFormat === "openai-responses") return "@ai-sdk/openai";
  return "@ai-sdk/openai-compatible";
}

/**
 * anthropic 格式的存库 baseUrl 沿用 Claude Code 的 ANTHROPIC_BASE_URL 惯例(不带 /v1),
 * 而 @ai-sdk/anthropic 的 baseURL 需要带 /v1,这里补齐(与 server getLLMClient 同规则)。
 */
function resolveBaseUrl(input: AcpProfileEnvInput): string | undefined {
  if (!input.baseUrl || input.apiFormat !== "anthropic") return input.baseUrl;
  const trimmed = input.baseUrl.replace(/\/$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

/**
 * 权限档位 → opencode config 的 permission 块。只有「完全访问」注入(强制全
 * 放行,覆盖用户自己的 opencode 配置);build/plan 不注入,尊重 opencode
 * 自身/用户配置的默认,其 "ask" 经 ACP session/request_permission 走审批卡片。
 */
function resolvePermissionConfig(
  permissionMode?: string
): Record<string, string> | undefined {
  if (permissionMode === "full-access") {
    return { edit: "allow", bash: "allow", webfetch: "allow" };
  }
  return undefined;
}

/**
 * Build the `OPENCODE_CONFIG_CONTENT` for AgeWork's custom OpenAI-compatible
 * provider. The API key is referenced via `{env:...}` so it never appears inline
 * in the config JSON (and is redacted in traces).
 */
function buildCustomConfig(input: AcpProfileEnvInput): string {
  const model = input.model ?? "";
  const permission = resolvePermissionConfig(input.permissionMode);
  return JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    model: `${OPENCODE_PROVIDER}/${model}`,
    ...(permission ? { permission } : {}),
    provider: {
      [OPENCODE_PROVIDER]: {
        npm: resolveProviderNpm(input.apiFormat),
        name: "AgeWork",
        options: {
          baseURL: resolveBaseUrl(input),
          apiKey: "{env:AGEWORK_OPENCODE_API_KEY}",
        },
        models: { [model]: { name: model } },
      },
    },
  });
}

/** OpenCode is the first ACP-compatible agent (`opencode acp`). */
export const openCodeAcpProfile: AcpAgentProfile = {
  agentType: "opencode",
  displayName: "OpenCode",
  command: "opencode",
  args: ["acp"],
  buildEnv(input) {
    const env: Record<string, string> = {
      ...input.baseEnv,
      // AgeWork manages the CLI version; disable OpenCode self-update.
      OPENCODE_DISABLE_AUTOUPDATE: "true",
    };

    // System mode: OpenCode 用自己的 auth/全局配置;仅「完全访问」档叠加
    // 权限块(OPENCODE_CONFIG_CONTENT 与全局/项目配置合并,优先级最高)。
    if (input.source === "system") {
      const permission = resolvePermissionConfig(input.permissionMode);
      if (permission) {
        env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          permission,
        });
      }
      return env;
    }

    // Custom mode: inject an ephemeral provider config (never written to disk).
    if (input.baseUrl && input.model) {
      env.OPENCODE_CONFIG_CONTENT = buildCustomConfig(input);
      if (input.apiKey) env.AGEWORK_OPENCODE_API_KEY = input.apiKey;
    }
    return env;
  },
};
