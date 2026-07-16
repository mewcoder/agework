import { describe, expect, it, vi } from "vitest";
import { ModelProviderService } from "./model-provider.service";

function createService(overrides: Record<string, unknown> = {}) {
  const repo = {
    findById: vi.fn().mockResolvedValue(null),
    findEnabled: vi.fn().mockResolvedValue(null),
    findManyByApiFormats: vi.fn().mockResolvedValue([]),
    findAll: vi.fn().mockResolvedValue([]),
    findIdByName: vi.fn().mockResolvedValue(null),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    ...overrides,
  };
  const configService = {
    isSystemEnvEnabled: vi.fn().mockReturnValue(true),
  };
  const runtimeHostService = {
    getResolvedCliPaths: vi.fn().mockResolvedValue({
      claude: "/usr/bin/claude",
      codex: null,
    }),
  };

  return {
    repo,
    configService,
    runtimeHostService,
    service: new ModelProviderService(
      repo as never,
      configService as never,
      runtimeHostService as never
    ),
  };
}

describe("ModelProviderService", () => {
  it("desensitizes apiKey for listEnabled (non-admin) responses", async () => {
    const { service } = createService({
      findManyByApiFormats: vi.fn().mockResolvedValue([
        {
          id: "mp-1",
          apiFormat: "anthropic",
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

    // list[0] is the virtual system provider, list[1] is the custom one
    const customProvider = result.list.find(
      (p) => p.modelProviderId === "mp-1"
    );
    expect(JSON.parse(customProvider!.providerConfig)).toEqual({
      baseUrl: "https://example.com/anthropic",
      apiKey: "",
      models: ["claude-test"],
      extraConfig: {},
    });
  });

  it("keeps the real apiKey for listForAdmin (admin) responses", async () => {
    const { service } = createService({
      findAll: vi.fn().mockResolvedValue([
        {
          id: "mp-1",
          apiFormat: "anthropic",
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

    const result = await service.listForAdmin();

    expect(JSON.parse(result.list[0].providerConfig)).toEqual({
      baseUrl: "https://example.com/anthropic",
      apiKey: "sk-secret",
      models: ["claude-test"],
      extraConfig: {},
    });
  });

  it("includes virtual system provider in listEnabled when system env is enabled", async () => {
    const { service, configService } = createService();
    configService.isSystemEnvEnabled.mockReturnValue(true);

    const result = await service.listEnabled("claude");

    const systemProvider = result.list.find(
      (p) => p.modelProviderId === "system"
    );
    expect(systemProvider).toBeDefined();
    expect(systemProvider!.scope).toBe("system");
    expect(systemProvider!.name).toBe("系统环境");
    expect(systemProvider!.isEnabled).toBe(true);
  });

  it("excludes virtual system provider from listEnabled when system env is disabled", async () => {
    const { service, configService } = createService();
    configService.isSystemEnvEnabled.mockReturnValue(false);

    const result = await service.listEnabled("claude");

    const systemProvider = result.list.find(
      (p) => p.modelProviderId === "system"
    );
    expect(systemProvider).toBeUndefined();
  });

  it("resolves a system provider when system env switch is enabled", async () => {
    const { service, configService } = createService();
    configService.isSystemEnvEnabled.mockReturnValue(true);

    await expect(
      service.resolveEnabledProvider("claude", "system")
    ).resolves.toEqual({ source: "system" });
  });

  it("returns null for a system provider when system env switch is disabled", async () => {
    const { service, configService, repo } = createService();
    configService.isSystemEnvEnabled.mockReturnValue(false);

    await expect(
      service.resolveEnabledProvider("claude", "system")
    ).resolves.toBeNull();
    // Should NOT query the database for system providers
    expect(repo.findEnabled).not.toHaveBeenCalled();
  });

  it("resolves an enabled custom provider with its saved config", async () => {
    const { service } = createService({
      findEnabled: vi.fn().mockResolvedValue({
        id: "mp-1",
        apiFormat: "anthropic",
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
      apiFormat: "anthropic",
      providerConfig: {
        baseUrl: "https://example.com",
        apiKey: "sk-test",
        models: ["claude-test"],
        extraConfig: { FOO: "bar" },
      },
    });
  });

  it("queries listEnabled by the agent's declared api formats", async () => {
    const findManyByApiFormats = vi.fn().mockResolvedValue([]);
    const { service, configService } = createService({ findManyByApiFormats });
    configService.isSystemEnvEnabled.mockReturnValue(false);

    await service.listEnabled("codex");

    expect(findManyByApiFormats).toHaveBeenCalledWith(
      ["openai-responses"],
      false
    );
  });

  it("returns null from resolveEnabledProvider when the agent does not consume the format", async () => {
    const { service } = createService({
      findEnabled: vi.fn().mockResolvedValue({
        id: "mp-1",
        apiFormat: "openai-compatible",
        scope: "global",
        isEnabled: true,
        baseUrl: "https://example.com",
        apiKey: "sk-test",
        models: ["m"],
        extraConfig: {},
      }),
    });

    await expect(
      service.resolveEnabledProvider("claude", "mp-1")
    ).resolves.toBeNull();
  });

  it("rejects create with an unknown api format", async () => {
    const { service } = createService();

    await expect(
      service.create("grpc", "bad", {
        baseUrl: "https://example.com",
        apiKey: "sk",
        models: ["m"],
        extraConfig: {},
      })
    ).rejects.toThrow("不支持的 API 格式");
  });

  it("rejects setEnabled for system provider", async () => {
    const { service } = createService();

    await expect(service.setEnabled("system", true)).rejects.toThrow(
      "系统环境不可通过模型服务管理启用/停用"
    );
  });

  describe("test", () => {
    it("rejects connectivity tests for the system provider", async () => {
      const { service } = createService();
      await expect(service.ping("system")).rejects.toThrow(
        "系统环境不支持连通性测试"
      );
    });

    it("fails fast without an ai-sdk call when no model is configured", async () => {
      const { service } = createService({
        findById: vi.fn().mockResolvedValue({
          id: "mp-1",
          apiFormat: "openai-responses",
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
