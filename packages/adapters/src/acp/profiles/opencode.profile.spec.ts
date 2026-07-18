import { describe, it, expect } from "vitest";
import { openCodeAcpProfile } from "./opencode.profile";
import { getAcpProfile, isAcpAgent } from "./registry";

const baseEnv = { PATH: "/usr/bin", HOME: "/home/x" };

describe("openCodeAcpProfile", () => {
  it("launches via `opencode acp`", () => {
    expect(openCodeAcpProfile.command).toBe("opencode");
    expect(openCodeAcpProfile.args).toEqual(["acp"]);
  });

  it("system mode uses the agent's own config; only full-access injects a permission block", () => {
    const env = openCodeAcpProfile.buildEnv({ source: "system", baseEnv });
    expect(env.OPENCODE_DISABLE_AUTOUPDATE).toBe("true");
    expect(env.OPENCODE_CONFIG_CONTENT).toBeUndefined();
    expect(env.AGEWORK_OPENCODE_API_KEY).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");

    const fullAccess = openCodeAcpProfile.buildEnv({
      source: "system",
      baseEnv,
      permissionMode: "full-access",
    });
    const config = JSON.parse(fullAccess.OPENCODE_CONFIG_CONTENT!);
    expect(config.provider).toBeUndefined();
    expect(config.permission).toEqual({
      edit: "allow",
      bash: "allow",
      webfetch: "allow",
    });
  });

  it("build/plan leave opencode's own permission config untouched in custom mode", () => {
    const configOf = (permissionMode?: string) =>
      JSON.parse(
        openCodeAcpProfile.buildEnv({
          source: "custom",
          baseEnv,
          baseUrl: "u",
          model: "m",
          ...(permissionMode ? { permissionMode } : {}),
        }).OPENCODE_CONFIG_CONTENT!
      );

    expect(configOf("build").permission).toBeUndefined();
    // plan 的只读约束由 session mode 承担,同样不注权限块。
    expect(configOf("plan").permission).toBeUndefined();
    expect(configOf(undefined).permission).toBeUndefined();
    expect(configOf("full-access").permission).toEqual({
      edit: "allow",
      bash: "allow",
      webfetch: "allow",
    });
  });

  it("custom mode injects an ephemeral provider config via env (never on disk)", () => {
    const env = openCodeAcpProfile.buildEnv({
      source: "custom",
      baseEnv,
      apiKey: "sk-secret-123",
      baseUrl: "https://api.example.com/v1",
      model: "gpt-4o",
    });
    expect(env.OPENCODE_CONFIG_CONTENT).toBeTruthy();
    expect(env.AGEWORK_OPENCODE_API_KEY).toBe("sk-secret-123");

    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
    expect(config.model).toBe("_agework/gpt-4o");
    expect(config.provider._agework.options.baseURL).toBe(
      "https://api.example.com/v1"
    );
    // API key is referenced via {env:...}, never inlined.
    expect(config.provider._agework.options.apiKey).toBe(
      "{env:AGEWORK_OPENCODE_API_KEY}"
    );
    expect(env.OPENCODE_CONFIG_CONTENT).not.toContain("sk-secret-123");
  });

  it("derives the provider npm from apiFormat, defaulting to openai-compatible", () => {
    const def = JSON.parse(
      openCodeAcpProfile.buildEnv({
        source: "custom",
        baseEnv,
        baseUrl: "u",
        model: "m",
      }).OPENCODE_CONFIG_CONTENT
    );
    expect(def.provider._agework.npm).toBe("@ai-sdk/openai-compatible");

    const responses = JSON.parse(
      openCodeAcpProfile.buildEnv({
        source: "custom",
        baseEnv,
        baseUrl: "u",
        model: "m",
        apiFormat: "openai-responses",
      }).OPENCODE_CONFIG_CONTENT
    );
    expect(responses.provider._agework.npm).toBe("@ai-sdk/openai");

    const compatible = JSON.parse(
      openCodeAcpProfile.buildEnv({
        source: "custom",
        baseEnv,
        baseUrl: "u",
        model: "m",
        apiFormat: "openai-compatible",
      }).OPENCODE_CONFIG_CONTENT
    );
    expect(compatible.provider._agework.npm).toBe("@ai-sdk/openai-compatible");

    const anthropic = JSON.parse(
      openCodeAcpProfile.buildEnv({
        source: "custom",
        baseEnv,
        baseUrl: "u",
        model: "m",
        apiFormat: "anthropic",
      }).OPENCODE_CONFIG_CONTENT
    );
    expect(anthropic.provider._agework.npm).toBe("@ai-sdk/anthropic");
  });

  it("appends /v1 to the anthropic baseURL (ANTHROPIC_BASE_URL convention stores it without)", () => {
    const build = (baseUrl: string, apiFormat: string) =>
      JSON.parse(
        openCodeAcpProfile.buildEnv({
          source: "custom",
          baseEnv,
          baseUrl,
          model: "m",
          apiFormat,
        }).OPENCODE_CONFIG_CONTENT
      ).provider._agework.options.baseURL;

    expect(build("https://api.anthropic.com", "anthropic")).toBe(
      "https://api.anthropic.com/v1"
    );
    expect(build("https://api.anthropic.com/v1", "anthropic")).toBe(
      "https://api.anthropic.com/v1"
    );
    // openai 格式不动用户填的地址
    expect(build("https://api.example.com/v1", "openai-compatible")).toBe(
      "https://api.example.com/v1"
    );
  });
});

describe("ACP profile registry", () => {
  it("resolves opencode and rejects unknown agents", () => {
    expect(getAcpProfile("opencode")).toBe(openCodeAcpProfile);
    expect(getAcpProfile("claude")).toBeUndefined();
    expect(isAcpAgent("opencode")).toBe(true);
    expect(isAcpAgent("codex")).toBe(false);
  });
});
