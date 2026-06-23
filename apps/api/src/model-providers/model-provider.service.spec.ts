import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "fs";
import { ModelProviderService } from "./model-provider.service";
import { PrismaService } from "../prisma/prisma.service";

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(),
}));

vi.mock("fs", () => ({
  existsSync: vi.fn(),
}));

function createService(
  overrides: Partial<PrismaService["modelProvider"]> = {}
) {
  const prisma = {
    modelProvider: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
      update: vi.fn(),
      ...overrides,
    },
  };

  return {
    prisma,
    service: new ModelProviderService(prisma as unknown as PrismaService),
  };
}

describe("ModelProviderService", () => {
  const mockSpawnSync = vi.mocked(spawnSync);
  const mockExistsSync = vi.mocked(existsSync);

  it("desensitizes apiKey for listEnabled (non-admin) responses", async () => {
    const { service } = createService({
      findMany: vi.fn().mockResolvedValue([
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

    expect(JSON.parse(result.list[0]!.providerConfig)).toEqual({
      baseUrl: "https://example.com/anthropic",
      apiKey: "",
      models: ["claude-test"],
      extraConfig: {},
    });
  });

  it("keeps the real apiKey for listForAdmin (admin) responses", async () => {
    const { service } = createService({
      findMany: vi.fn().mockResolvedValue([
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

    expect(JSON.parse(result.list[0]!.providerConfig)).toEqual({
      baseUrl: "https://example.com/anthropic",
      apiKey: "sk-secret",
      models: ["claude-test"],
      extraConfig: {},
    });
  });

  it("creates system model providers disabled by default", async () => {
    const { prisma, service } = createService();

    await service.onModuleInit();

    expect(prisma.modelProvider.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: "system:claude",
        agentType: "claude",
        scope: "system",
        name: "系统环境",
        isEnabled: false,
        baseUrl: "",
        apiKey: "",
        models: [],
        extraConfig: {},
      }),
    });
    expect(prisma.modelProvider.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: "system:codex",
        agentType: "codex",
        scope: "system",
        name: "系统环境",
        isEnabled: false,
        baseUrl: "",
        apiKey: "",
        models: [],
        extraConfig: {},
      }),
    });
  });

  it("includes system status for system providers", async () => {
    const originalAnthropicAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
    process.env.ANTHROPIC_AUTH_TOKEN = "sk-test";
    mockSpawnSync.mockReturnValue({ status: 0 } as never);
    mockExistsSync.mockReturnValue(false);

    try {
      const { service } = createService({
        findMany: vi.fn().mockResolvedValue([
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
    mockExistsSync.mockImplementation((path) =>
      String(path) === "/custom/claude/.credentials.json"
    );

    try {
      const { service } = createService({
        findMany: vi.fn().mockResolvedValue([
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
      expect(mockExistsSync).toHaveBeenCalledWith(
        "/custom/claude/.credentials.json"
      );
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
    mockExistsSync.mockImplementation((path) =>
      String(path) === "/custom/claude/.credentials.json"
    );

    try {
      const { service } = createService();

      expect(service.getSystemInfo("claude").configFiles).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: "/custom/claude/.credentials.json",
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
      findFirst: vi.fn().mockResolvedValue({
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
    const { prisma, service } = createService({
      findFirst: vi.fn().mockResolvedValue(null),
    });

    await expect(
      service.resolveEnabledProvider("claude", "system:claude")
    ).resolves.toBeNull();
    expect(prisma.modelProvider.findFirst).toHaveBeenCalledWith({
      where: { id: "system:claude", agentType: "claude", isEnabled: true },
    });
  });

  it("resolves an enabled custom provider with its saved config", async () => {
    const { service } = createService({
      findFirst: vi.fn().mockResolvedValue({
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
});
