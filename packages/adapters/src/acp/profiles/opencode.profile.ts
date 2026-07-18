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
 * 权限档位 → opencode config 的 permission 块。build/plan 都使用 AgeWork
 * 定义的策略,不受用户本地 permission:{"*":"ask"} 覆盖;full-access 则强制
 * 全部放行。
 *
 * OpenCode 文档规定 agent 权限优先于全局 permission,因此完全访问还要覆盖
 * 当前 ACP 使用的 build agent,否则本地 agent.build.permission 仍可能保留 ask。
 */
function resolvePermissionConfig(
  permissionMode?: string
): Record<string, unknown> | undefined {
  if (permissionMode === "plan") {
    return {
      "*": "deny",
      read: {
        "*": "allow",
        "*.env": "deny",
        "*.env.*": "deny",
        "*.env.example": "allow",
      },
      glob: "allow",
      grep: "allow",
      lsp: "allow",
      webfetch: "allow",
      task: "allow",
      skill: "allow",
      bash: "ask",
      external_directory: "ask",
      edit: "deny",
    };
  }
  if (permissionMode === "build") {
    return {
      "*": "allow",
      edit: "allow",
      bash: "allow",
      webfetch: "allow",
      glob: "allow",
      grep: "allow",
      task: "allow",
      skill: "allow",
      lsp: "allow",
      websearch: "allow",
      external_directory: "ask",
      doom_loop: "ask",
      read: {
        "*": "allow",
        "*.env": "deny",
        "*.env.*": "deny",
        "*.env.example": "allow",
      },
    };
  }
  if (permissionMode === "full-access") {
    return {
      // 通配只兜住 opencode 未来新增的权限键;它盖不住更具体的键,所以内置
      // 默认为 "ask" 的那几项必须逐个列出,否则「完全访问」仍会弹审批卡片。
      "*": "allow",
      edit: "allow",
      bash: "allow",
      webfetch: "allow",
      // 内置默认:read 对 *.env / *.env.* 是 ask。
      read: "allow",
      // 内置默认:这两项整体就是 ask。
      external_directory: "allow",
      doom_loop: "allow",
    };
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
  const permissionAgent = input.permissionMode === "plan" ? "plan" : "build";
  return JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    model: `${OPENCODE_PROVIDER}/${model}`,
    ...(permission ? { permission } : {}),
    ...(permission ? { agent: { [permissionAgent]: { permission } } } : {}),
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
        const permissionAgent = input.permissionMode === "plan" ? "plan" : "build";
        env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          permission,
          agent: { [permissionAgent]: { permission } },
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
