import { describe, it, expect, vi, beforeEach } from "vitest";
import { BadRequestException } from "@nestjs/common";
import { AgentSpecBuilder } from "./agent-spec.builder";
import { ModelProviderService } from "../model-providers/model-provider.service";

describe("AgentSpecBuilder", () => {
  let modelProviderService: Partial<ModelProviderService>;
  let builder: AgentSpecBuilder;

  beforeEach(() => {
    modelProviderService = {
      resolveEnabledConfig: vi.fn().mockResolvedValue({
        providerConfig: {},
        providerSource: "environment",
      }),
    };
    builder = new AgentSpecBuilder(
      modelProviderService as ModelProviderService
    );
  });

  it("builds an environment adapter config when provider source is environment", async () => {
    const spec = await builder.build({
      agentType: "claude",
      modelProviderId: "mp-1",
    });
    expect(spec.agentType).toBe("claude");
    expect(spec.adapter).toEqual({ kind: "claude", isEnvironmentConfig: true });
  });

  it("builds a custom adapter config from database provider config", async () => {
    modelProviderService.resolveEnabledConfig = vi.fn().mockResolvedValue({
      providerConfig: {
        baseUrl: "https://example.com",
        apiKey: "sk-test",
        models: ["claude-test"],
        extraConfig: { FOO: "bar" },
      },
      providerSource: "database",
    });

    const spec = await builder.build({
      agentType: "claude",
      modelProviderId: "mp-1",
      model: "claude-test",
    });

    expect(spec.adapter).toEqual({
      kind: "claude",
      isEnvironmentConfig: false,
      baseUrl: "https://example.com",
      apiKey: "sk-test",
      model: "claude-test",
      extraConfig: { FOO: "bar" },
    });
  });

  it("uses the requested model when it belongs to the selected provider", async () => {
    modelProviderService.resolveEnabledConfig = vi.fn().mockResolvedValue({
      providerConfig: {
        baseUrl: "https://example.com",
        apiKey: "sk-test",
        models: ["claude-fast", "claude-deep"],
        extraConfig: {},
      },
      providerSource: "database",
    });

    const spec = await builder.build({
      agentType: "claude",
      modelProviderId: "mp-1",
      model: "claude-deep",
    });

    expect(spec.adapter).toMatchObject({ model: "claude-deep" });
  });

  it("throws when no model is selected for a custom provider config", async () => {
    modelProviderService.resolveEnabledConfig = vi.fn().mockResolvedValue({
      providerConfig: {
        baseUrl: "https://example.com",
        apiKey: "sk-test",
        models: ["claude-test"],
        extraConfig: {},
      },
      providerSource: "database",
    });

    await expect(
      builder.build({ agentType: "claude", modelProviderId: "mp-1" })
    ).rejects.toThrow(BadRequestException);
  });

  it("throws when the requested model is not in the provider's models list", async () => {
    modelProviderService.resolveEnabledConfig = vi.fn().mockResolvedValue({
      providerConfig: {
        baseUrl: "https://example.com",
        apiKey: "sk-test",
        models: ["claude-test"],
        extraConfig: {},
      },
      providerSource: "database",
    });

    await expect(
      builder.build({
        agentType: "claude",
        modelProviderId: "mp-1",
        model: "claude-unknown",
      })
    ).rejects.toThrow(BadRequestException);
  });

  it("throws when custom provider config is missing required fields", async () => {
    modelProviderService.resolveEnabledConfig = vi.fn().mockResolvedValue({
      providerConfig: { baseUrl: "", apiKey: "", models: [], extraConfig: {} },
      providerSource: "database",
    });

    await expect(
      builder.build({ agentType: "claude", modelProviderId: "mp-1" })
    ).rejects.toThrow(BadRequestException);
  });

  it("throws for an unsupported agent type", async () => {
    await expect(
      builder.build({ agentType: "unknown", modelProviderId: "mp-1" })
    ).rejects.toThrow(BadRequestException);
  });
});
