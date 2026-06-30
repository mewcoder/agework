import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "fs";
import { join } from "path";
import { ModelProviderService } from "./model-provider.service";

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(),
}));

vi.mock("fs", () => ({
  existsSync: vi.fn(),
}));

function createService(overrides: Record<string, unknown> = {}) {
  const repo = {
    findById: vi.fn().mockResolvedValue(null),
    findEnabled: vi.fn().mockResolvedValue(null),
    findManyByAgent: vi.fn().mockResolvedValue([]),
    findIdByName: vi.fn().mockResolvedValue(null),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    ...overrides,
  };

  return {
    repo,
    service: new ModelProviderService(repo as never),
  };
}

describe("ModelProviderService", () => {
  const mockSpawnSync = vi.mocked(spawnSync);
  const mockExistsSync = vi.mocked(existsSync);

  it("desensitizes apiKey for listEnabled (non-admin) responses", async () => {
    const { service } = createService({
      findManyByAgent: vi.fn().mockResolvedValue([
        {
          id: "mp-1",
          agentType: "claude",
          scope: "global",
          userId: null,
          name: "test",
          isEnabled: true,
          baseUrl: "https://example.com/anthropic",
          apiKey: "sk-secret",
          models: ["claude-test"],
          extraConfig: {},
          createdAt: new Date("2026-06-13T09:19:50.022Z"),
          updatedAt: new Date("2026-06-13T09:20:29.205Z"),
        },
      ]),
    });

    const result = await service.listEnabled("claude");

    expect(JSON.parse(result.list[0].providerConfig)).toEqual({
      baseUrl: "https://example.com/anthropic",
      apiKey: "",
      models: ["claude-test"],
      extraConfig: {},
    });
  });

  it("keeps the real apiKey for listForAdmin (admin) responses", async () => {
    const { service } = createService({
      findManyByAgent: vi.fn().mockResolvedValue([
        {
          id: "mp-1",
          agentType: "claude",
          scope: "global",
          userId: null,
          name: "test",
          isEnabled: true,
          baseUrl: "https://example.com/anthropic",
          apiKey: "sk-secret",
          models: ["claude-test"],
          extraConfig: {},
          createdAt: new Date("2026-06-13T09:19:50.022Z"),
          updatedAt: new Date("2026-06-13T09:20:29.205Z"),
        },
      ]),
    });

    const result = await service.listForAdmin("claude");

    expect(JSON.parse(result.list[0].providerConfig)).toEqual({
      baseUrl: "https://example.com/anthropic",
      apiKey: "sk-secret",
      models: ["claude-test"],
      extraConfig: {},
    });
  });

  it("creates system model providers disabled by default", async () => {
    const { repo, service } = createService();

    await service.onModuleInit();

    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "system:claude",
        agentType: "claude",
        scope: "system",
        name: "系统环境",
        isEnabled: false,
        baseUrl: "",
        apiKey: "",
        models: [],
        extraConfig: {},
      })
    );
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "system:codex",
        agentType: "codex",
        scope: "system",
        name: "系统环境",
        isEnabled: false,
        baseUrl: "",
        apiKey: "",
        models: [],
        extraConfig: {},
      })
    );
  });

  it("includes system status for system providers", async () => {
    const originalAnthropicAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
    process.env.ANTHROPIC_AUTH_TOKEN = "sk-test";
    mockSpawnSync.mockReturnValue({ status: 0 } as never);
    mockExistsSync.mockReturnValue(false);

    try {
      const { service } = createService({
        findManyByAgent: vi.fn().mockResolvedValue([
          {
            id: "system:claude",
            agentType: "claude",
            scope: "system",
            userId: null,
            name: "系统环境",
            isEnabled: false,
            baseUrl: "",
            apiKey: "",
            models: [],
            extraConfig: {},
            createdAt: new Date("2026-06-13T09:19:50.022Z"),
            updatedAt: new Date("2026-06-13T09:20:29.205Z"),
          },
        ]),
      });

      const result = await service.listForAdmin("claude");

      expect(result.list[0]?.systemStatus).toEqual({
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

  it("treats Claude Code credentials under CLAUDE_CONFIG_DIR as system config", async () => {
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
      const { service } = createService({
        findManyByAgent: vi.fn().mockResolvedValue([
          {
            id: "system:claude",
            agentType: "claude",
            scope: "system",
            userId: null,
            name: "系统环境",
            isEnabled: false,
            baseUrl: "",
            apiKey: "",
            models: [],
            extraConfig: {},
            createdAt: new Date("2026-06-13T09:19:50.022Z"),
            updatedAt: new Date("2026-06-13T09:20:29.205Z"),
          },
        ]),
      });

      const result = await service.listForAdmin("claude");

      expect(result.list[0]?.systemStatus?.configAvailable).toBe(true);
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

  it("reports Claude Code account credential files in system info", () => {
    const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = "/custom/claude";
    const credentialsPath = join("/custom/claude", ".credentials.json");
    mockExistsSync.mockImplementation(
      (path) => String(path) === credentialsPath
    );

    try {
      const { service } = createService();

      expect(service.getSystemInfo("claude").configFiles).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: credentialsPath,
            exists: true,
            description: "账号登录认证文件",
          }),
        ])
      );
    } finally {
      if (originalClaudeConfigDir === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
      } else {
        process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
      }
    }
  });

  it("resolves an enabled system provider from database state", async () => {
    const { service } = createService({
      findEnabled: vi.fn().mockResolvedValue({
        id: "system:claude",
        agentType: "claude",
        scope: "system",
        isEnabled: true,
        baseUrl: "",
        apiKey: "",
        models: [],
        extraConfig: {},
      }),
    });

    await expect(
      service.resolveEnabledProvider("claude", "system:claude")
    ).resolves.toEqual({ source: "system" });
  });

  it("returns null when a system provider is not enabled in database state", async () => {
    const { repo, service } = createService({
      findEnabled: vi.fn().mockResolvedValue(null),
    });

    await expect(
      service.resolveEnabledProvider("claude", "system:claude")
    ).resolves.toBeNull();
    expect(repo.findEnabled).toHaveBeenCalledWith("system:claude", "claude");
  });

  it("resolves an enabled custom provider with its saved config", async () => {
    const { service } = createService({
      findEnabled: vi.fn().mockResolvedValue({
        id: "mp-1",
        agentType: "claude",
        scope: "global",
        isEnabled: true,
        baseUrl: "https://example.com",
        apiKey: "sk-test",
        models: ["claude-test"],
        extraConfig: { FOO: "bar" },
      }),
    });

    await expect(
      service.resolveEnabledProvider("claude", "mp-1")
    ).resolves.toEqual({
      source: "custom",
      providerConfig: {
        baseUrl: "https://example.com",
        apiKey: "sk-test",
        models: ["claude-test"],
        extraConfig: { FOO: "bar" },
      },
    });
  });

  describe("test", () => {
    it("rejects connectivity tests for the system provider", async () => {
      const { service } = createService();
      await expect(service.ping("system:claude")).rejects.toThrow(
        "系统环境不支持连通性测试"
      );
    });

    it("fails fast without an ai-sdk call when no model is configured", async () => {
      const { service } = createService({
        findById: vi.fn().mockResolvedValue({
          id: "mp-1",
          agentType: "codex",
          scope: "global",
          isEnabled: true,
          baseUrl: "https://example.com",
          apiKey: "sk-test",
          models: [],
          extraConfig: {},
        }),
      });

      await expect(service.ping("mp-1")).resolves.toEqual({
        success: false,
        latency: 0,
        error: "未配置 models",
      });
    });
  });
});
