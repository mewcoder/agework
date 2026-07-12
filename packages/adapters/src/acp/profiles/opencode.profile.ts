import type { AcpAgentProfile, AcpProfileEnvInput } from "./profile";

const OPENCODE_PROVIDER = "_agework";
const DEFAULT_PROVIDER_NPM = "@ai-sdk/openai-compatible";
// Only these provider npm packages may be selected via extraConfig (doc §7.2).
const ALLOWED_PROVIDER_NPM = new Set([
  "@ai-sdk/openai-compatible",
  "@ai-sdk/openai",
]);

function resolveProviderNpm(extraConfig?: Record<string, string>): string {
  const requested = extraConfig?.providerNpm;
  return requested && ALLOWED_PROVIDER_NPM.has(requested)
    ? requested
    : DEFAULT_PROVIDER_NPM;
}

/**
 * Build the `OPENCODE_CONFIG_CONTENT` for AgeWork's custom OpenAI-compatible
 * provider. The API key is referenced via `{env:...}` so it never appears inline
 * in the config JSON (and is redacted in traces).
 */
function buildCustomConfig(input: AcpProfileEnvInput): string {
  const model = input.model ?? "";
  return JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    model: `${OPENCODE_PROVIDER}/${model}`,
    provider: {
      [OPENCODE_PROVIDER]: {
        npm: resolveProviderNpm(input.extraConfig),
        name: "AgeWork",
        options: {
          baseURL: input.baseUrl,
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
  npmPackage: "opencode-ai",
  binaryName: "opencode",
  buildEnv(input) {
    const env: Record<string, string> = {
      ...input.baseEnv,
      // AgeWork manages the CLI version; disable OpenCode self-update.
      OPENCODE_DISABLE_AUTOUPDATE: "true",
    };

    // System mode: let OpenCode use its own auth.json / global / project config.
    if (input.source === "system") return env;

    // Custom mode: inject an ephemeral provider config (never written to disk).
    if (input.baseUrl && input.model) {
      env.OPENCODE_CONFIG_CONTENT = buildCustomConfig(input);
      if (input.apiKey) env.AGEWORK_OPENCODE_API_KEY = input.apiKey;
    }
    return env;
  },
};
