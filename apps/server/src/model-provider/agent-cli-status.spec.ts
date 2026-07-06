import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "fs";
import { join } from "path";
import { getSystemStatus } from "./agent-cli-status";

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(),
}));

vi.mock("fs", () => ({
  existsSync: vi.fn(),
}));

describe("getSystemStatus", () => {
  const mockSpawnSync = vi.mocked(spawnSync);
  const mockExistsSync = vi.mocked(existsSync);

  it("reports command/config availability for claude via auth env", () => {
    const originalAnthropicAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
    process.env.ANTHROPIC_AUTH_TOKEN = "sk-test";
    mockSpawnSync.mockReturnValue({ status: 0 } as never);
    mockExistsSync.mockReturnValue(false);

    try {
      const status = getSystemStatus("claude");

      expect(status).toEqual({
        command: "claude",
        commandAvailable: true,
        configAvailable: true,
      });
      expect(mockSpawnSync).toHaveBeenCalledWith("claude", ["--version"], {
        stdio: "ignore",
        timeout: 1500,
      });
    } finally {
      if (originalAnthropicAuthToken === undefined) {
        delete process.env.ANTHROPIC_AUTH_TOKEN;
      } else {
        process.env.ANTHROPIC_AUTH_TOKEN = originalAnthropicAuthToken;
      }
    }
  });

  it("treats Claude Code credentials under CLAUDE_CONFIG_DIR as available config", () => {
    const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    const originalAnthropicAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
    const originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY;
    const originalClaudeCodeOauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.CLAUDE_CONFIG_DIR = "/custom/claude";
    mockSpawnSync.mockReturnValue({ status: 0 } as never);
    const credentialsPath = join("/custom/claude", ".credentials.json");
    mockExistsSync.mockImplementation(
      (path) => String(path) === credentialsPath
    );

    try {
      const status = getSystemStatus("claude");

      expect(status.configAvailable).toBe(true);
      expect(mockExistsSync).toHaveBeenCalledWith(credentialsPath);
    } finally {
      if (originalClaudeConfigDir === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
      } else {
        process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
      }
      if (originalAnthropicAuthToken === undefined) {
        delete process.env.ANTHROPIC_AUTH_TOKEN;
      } else {
        process.env.ANTHROPIC_AUTH_TOKEN = originalAnthropicAuthToken;
      }
      if (originalAnthropicApiKey === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = originalAnthropicApiKey;
      }
      if (originalClaudeCodeOauthToken === undefined) {
        delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      } else {
        process.env.CLAUDE_CODE_OAUTH_TOKEN = originalClaudeCodeOauthToken;
      }
    }
  });

  it("reports codex command/config availability via env vars", () => {
    const originalOpenaiApiKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-test";
    mockSpawnSync.mockReturnValue({ status: 0 } as never);
    mockExistsSync.mockReturnValue(false);

    try {
      const status = getSystemStatus("codex");

      expect(status).toEqual({
        command: "codex",
        commandAvailable: true,
        configAvailable: true,
      });
    } finally {
      if (originalOpenaiApiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = originalOpenaiApiKey;
      }
    }
  });
});
