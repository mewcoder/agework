import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { BadRequestException } from "@nestjs/common";
import { AgentRunConfigBuilder } from "./agent-run-config-builder";
import { ModelProviderService } from "../model-providers/model-provider.service";
import { ConfigService } from "../config/config.service";

describe("AgentRunConfigBuilder", () => {
  let modelProviderService: Partial<ModelProviderService>;
  let configService: Partial<ConfigService>;
  let builder: AgentRunConfigBuilder;

  beforeEach(() => {
    modelProviderService = {
      resolveEnabledConfig: vi.fn().mockResolvedValue({
        providerConfig: {},
        providerSource: "environment",
      }),
    };
    configService = {
      getRuntimeLogDir: vi.fn().mockReturnValue("/tmp/agework-logs/runtime"),
    };
    builder = new AgentRunConfigBuilder(
      modelProviderService as ModelProviderService,
      configService as ConfigService
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("includes workspaceId in the RunConfig", async () => {
    const config = await builder.buildRunConfig({
      agentType: "claude",
      modelProviderId: "mp-1",
      workspaceId: "ws-1",
      placement: {
        runtimeType: "local",
        isolationScope: "workspace",
        userId: "user-1",
        workspaceId: "ws-1",
        hostPath: "/tmp/ws",
        runtimePath: "/tmp/ws",
        mountTarget: "/tmp/ws",
      },
      runId: "run-1",
      conversationId: "conversation-1",
      input: {},
    });
    expect(config.workspaceId).toBe("ws-1");
  });

  it("uses placement.runtimePath for RunConfig.runtimePath", async () => {
    const config = await builder.buildRunConfig({
      agentType: "claude",
      modelProviderId: "mp-1",
      workspaceId: "ws-1",
      placement: {
        runtimeType: "docker",
        isolationScope: "workspace",
        userId: "user-1",
        workspaceId: "ws-1",
        hostPath: "/tmp/ws",
        runtimePath: "/workspace",
        mountTarget: "/workspace",
      },
      runId: "run-1",
      conversationId: "conversation-1",
      input: {},
    });
    expect(config.runtimePath).toBe("/workspace");
  });

  it("adds local agent event trace config only when enabled", async () => {
    vi.stubEnv("AGEWORK_AGENT_EVENT_TRACE_ENABLED", "true");
    vi.stubEnv("AGEWORK_AGENT_EVENT_TRACE_MAX_FILE_MB", "5");

    const config = await builder.buildRunConfig({
      agentType: "claude",
      modelProviderId: "mp-1",
      workspaceId: "ws-1",
      placement: {
        runtimeType: "local",
        isolationScope: "workspace",
        userId: "user-1",
        workspaceId: "ws-1",
        hostPath: "/tmp/ws",
        runtimePath: "/tmp/ws",
        mountTarget: "/tmp/ws",
      },
      runId: "run/1",
      conversationId: "conversation:1",
      input: {},
    });

    expect(config.agentEventTrace).toMatchObject({
      enabled: true,
      maxFileMb: 5,
      runId: "run/1",
      conversationId: "conversation:1",
      workspaceId: "ws-1",
      agentType: "claude",
    });
    expect(config.agentEventTrace?.rawFilePath).toMatch(
      /\/tmp\/agework-logs\/runtime\/conversation-1\.raw\.jsonl$/
    );
    expect(config.agentEventTrace?.rawRuntimeFilePath).toMatch(
      /\/tmp\/agework-logs\/runtime\/conversation-1\.raw\.jsonl$/
    );
    expect(config.agentEventTrace?.aguiFilePath).toMatch(
      /\/tmp\/agework-logs\/runtime\/conversation-1\.agui\.jsonl$/
    );
    expect(config.agentEventTrace?.rawFilePath).not.toContain("/tmp/ws");
    expect(config.workerLogFilePath).toBe(
      "/tmp/agework-logs/runtime/conversation-1.worker.log"
    );
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

    const config = await builder.buildRunConfig({
      agentType: "claude",
      modelProviderId: "mp-1",
      workspaceId: "ws-1",
      placement: {
        runtimeType: "local",
        isolationScope: "workspace",
        userId: "user-1",
        workspaceId: "ws-1",
        hostPath: "/tmp/ws",
        runtimePath: "/tmp/ws",
        mountTarget: "/tmp/ws",
      },
      runId: "run-1",
      conversationId: "conversation-1",
      input: {},
      model: "claude-test",
    });

    expect(config.adapter).toEqual({
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

    const config = await builder.buildRunConfig({
      agentType: "claude",
      modelProviderId: "mp-1",
      workspaceId: "ws-1",
      placement: {
        runtimeType: "local",
        isolationScope: "workspace",
        userId: "user-1",
        workspaceId: "ws-1",
        hostPath: "/tmp/ws",
        runtimePath: "/tmp/ws",
        mountTarget: "/tmp/ws",
      },
      runId: "run-1",
      conversationId: "conversation-1",
      input: {},
      model: "claude-deep",
    });

    expect(config.adapter).toMatchObject({
      model: "claude-deep",
    });
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
      builder.buildRunConfig({
        agentType: "claude",
        modelProviderId: "mp-1",
        workspaceId: "ws-1",
        placement: {
          runtimeType: "local",
          isolationScope: "workspace",
          userId: "user-1",
          workspaceId: "ws-1",
          hostPath: "/tmp/ws",
          runtimePath: "/tmp/ws",
          mountTarget: "/tmp/ws",
        },
        runId: "run-1",
        conversationId: "conversation-1",
        input: {},
      })
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
      builder.buildRunConfig({
        agentType: "claude",
        modelProviderId: "mp-1",
        workspaceId: "ws-1",
        placement: {
          runtimeType: "local",
          isolationScope: "workspace",
          userId: "user-1",
          workspaceId: "ws-1",
          hostPath: "/tmp/ws",
          runtimePath: "/tmp/ws",
          mountTarget: "/tmp/ws",
        },
        runId: "run-1",
        conversationId: "conversation-1",
        input: {},
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
      builder.buildRunConfig({
        agentType: "claude",
        modelProviderId: "mp-1",
        workspaceId: "ws-1",
        placement: {
          runtimeType: "local",
          isolationScope: "workspace",
          userId: "user-1",
          workspaceId: "ws-1",
          hostPath: "/tmp/ws",
          runtimePath: "/tmp/ws",
          mountTarget: "/tmp/ws",
        },
        runId: "run-1",
        conversationId: "conversation-1",
        input: {},
      })
    ).rejects.toThrow(BadRequestException);
  });
});
