import { describe, it, expect } from "vitest";
import { openCodeAcpProfile } from "./opencode.profile";
import { getAcpProfile, isAcpAgent } from "./registry";

const baseEnv = { PATH: "/usr/bin", HOME: "/home/x" };

/**
 * 「完全访问」注入的权限块。逐键列出而非只写 "*",因为 opencode 内置默认里
 * read(*.env)、external_directory、doom_loop 是 ask,更具体的键压过通配。
 */
const FULL_ACCESS_PERMISSION = {
  "*": "allow",
  edit: "allow",
  bash: "allow",
  webfetch: "allow",
  read: "allow",
  external_directory: "allow",
  doom_loop: "allow",
};

const BUILD_PERMISSION = {
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

const PLAN_PERMISSION = {
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
    expect(config.permission).toEqual(FULL_ACCESS_PERMISSION);
    expect(config.agent.build.permission).toEqual(FULL_ACCESS_PERMISSION);
  });

  it("build and plan inject AgeWork permission policies", () => {
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

    expect(configOf("build").permission).toEqual(BUILD_PERMISSION);
    expect(configOf("build").agent.build.permission).toEqual(BUILD_PERMISSION);
    expect(configOf("plan").permission).toEqual(PLAN_PERMISSION);
    expect(configOf("plan").agent.plan.permission).toEqual(PLAN_PERMISSION);
    expect(configOf(undefined).permission).toBeUndefined();
    expect(configOf("full-access").permission).toEqual(FULL_ACCESS_PERMISSION);
    expect(configOf("full-access").agent.build.permission).toEqual(
      FULL_ACCESS_PERMISSION
    );
  });

  it("full-access 覆盖 opencode 内置默认为 ask 的权限键", () => {
    const permission = JSON.parse(
      openCodeAcpProfile.buildEnv({
        source: "system",
        baseEnv,
        permissionMode: "full-access",
      }).OPENCODE_CONFIG_CONTENT!
    ).permission;

    // 回归防线:历史上只注入 edit/bash/webfetch,导致「完全访问」下读项目外
    // 文件、读 .env、重复调用检测仍会弹审批卡片,与档位描述不符。
    for (const key of ["external_directory", "doom_loop", "read"]) {
      expect(permission[key]).toBe("allow");
    }
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
