import { describe, it, expect } from "vitest";
import { openCodeAcpProfile } from "./opencode.profile";
import { getAcpProfile, isAcpAgent } from "./registry";

const baseEnv = { PATH: "/usr/bin", HOME: "/home/x" };

describe("openCodeAcpProfile", () => {
  it("launches via `opencode acp`", () => {
    expect(openCodeAcpProfile.command).toBe("opencode");
    expect(openCodeAcpProfile.args).toEqual(["acp"]);
    expect(openCodeAcpProfile.npmPackage).toBe("opencode-ai");
  });

  it("system mode uses the agent's own config and does not inject a provider", () => {
    const env = openCodeAcpProfile.buildEnv({ source: "system", baseEnv });
    expect(env.OPENCODE_DISABLE_AUTOUPDATE).toBe("true");
    expect(env.OPENCODE_CONFIG_CONTENT).toBeUndefined();
    expect(env.AGEWORK_OPENCODE_API_KEY).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
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

  it("defaults the provider npm and only allows the whitelist", () => {
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
        extraConfig: { providerNpm: "@ai-sdk/openai" },
      }).OPENCODE_CONFIG_CONTENT
    );
    expect(responses.provider._agework.npm).toBe("@ai-sdk/openai");

    const bogus = JSON.parse(
      openCodeAcpProfile.buildEnv({
        source: "custom",
        baseEnv,
        baseUrl: "u",
        model: "m",
        extraConfig: { providerNpm: "evil-package" },
      }).OPENCODE_CONFIG_CONTENT
    );
    expect(bogus.provider._agework.npm).toBe("@ai-sdk/openai-compatible");
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
