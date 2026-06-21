import { afterEach, describe, expect, it, vi } from "vitest";
import { pickSafeEnv } from "./safe-env";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("pickSafeEnv", () => {
  it("includes Claude Code account auth paths and tokens in environment config mode", () => {
    vi.stubEnv("HOME", "/Users/mew");
    vi.stubEnv("PATH", "/usr/bin");
    vi.stubEnv("CLAUDE_CONFIG_DIR", "/Users/mew/.claude");
    vi.stubEnv("CLAUDE_SECURESTORAGE_CONFIG_DIR", "/Users/mew/.claude-secure");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "oauth-token");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-api");
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "sk-auth");
    vi.stubEnv("AGEWORK_PRIVATE_DATABASE_URL", "postgres://secret");
    vi.stubEnv("AGEWORK_INTERNAL_RUNTIME_ACCESS_KEY", "internal-key");
    vi.stubEnv("CUSTOM_SYSTEM_TOOL_HOME", "/opt/tool");

    expect(pickSafeEnv(true)).toMatchObject({
      HOME: "/Users/mew",
      PATH: "/usr/bin",
      CLAUDE_CONFIG_DIR: "/Users/mew/.claude",
      CLAUDE_SECURESTORAGE_CONFIG_DIR: "/Users/mew/.claude-secure",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-token",
      ANTHROPIC_API_KEY: "sk-api",
      ANTHROPIC_AUTH_TOKEN: "sk-auth",
      CUSTOM_SYSTEM_TOOL_HOME: "/opt/tool",
    });
    expect(pickSafeEnv(true)).not.toHaveProperty("AGEWORK_PRIVATE_DATABASE_URL");
    expect(pickSafeEnv(true)).not.toHaveProperty("AGEWORK_INTERNAL_RUNTIME_ACCESS_KEY");
  });

  it("does not include Claude auth env vars in custom config mode", () => {
    vi.stubEnv("HOME", "/Users/mew");
    vi.stubEnv("CLAUDE_CONFIG_DIR", "/Users/mew/.claude");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "oauth-token");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-api");

    expect(pickSafeEnv(false)).toMatchObject({
      HOME: "/Users/mew",
    });
    expect(pickSafeEnv(false)).not.toHaveProperty("CLAUDE_CONFIG_DIR");
    expect(pickSafeEnv(false)).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
    expect(pickSafeEnv(false)).not.toHaveProperty("ANTHROPIC_API_KEY");
  });
});
