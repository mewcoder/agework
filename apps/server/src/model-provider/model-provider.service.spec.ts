import { describe, expect, it, vi } from "vitest";
import { ModelProviderService } from "./model-provider.service";

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
  const configService = {
    isSystemEnvEnabled: vi.fn().mockReturnValue(true),
  };
  const runtimeService = {
    getResolvedCliPaths: vi.fn().mockResolvedValue({
      claude: "/usr/bin/claude",
      codex: null,
    }),
  };

  return {
    repo,
    configService,
    runtimeService,
    service: new ModelProviderService(
      repo as never,
      configService as never,
      runtimeService as never
    ),
  };
}

describe("ModelProviderService", () => {
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
