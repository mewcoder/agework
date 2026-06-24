import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "path";
import { RunConfigAssembler } from "./run-config.assembler";
import { ConfigService } from "../config/config.service";
import type { AgentProviderConfig } from "@agework/shared/protocol";

const AGENT_PROVIDER_CONFIG: AgentProviderConfig = {
  agentType: "claude",
  source: "system",
};

describe("RunConfigAssembler", () => {
  let configService: Partial<ConfigService>;
  let assembler: RunConfigAssembler;

  beforeEach(() => {
    configService = {
      getRuntimeLogDir: vi.fn().mockReturnValue("/tmp/agework-logs/runtime"),
    };
    assembler = new RunConfigAssembler(configService as ConfigService);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("includes workspaceId in the RunConfig", () => {
    const config = assembler.assemble({
      agentProviderConfig: AGENT_PROVIDER_CONFIG,
      placement: {
        runtimeType: "local",
        isolationScope: "workspace",
        userId: "user-1",
        workspaceId: "ws-1",
        hostPath: "/tmp/ws",
        runtimePath: "/tmp/ws",
        mountTarget: "/tmp/ws",
      },
      workspaceId: "ws-1",
      runId: "run-1",
      conversationId: "conversation-1",
      input: {},
    });
    expect(config.workspaceId).toBe("ws-1");
    expect(config.agentProviderConfig).toBe(AGENT_PROVIDER_CONFIG);
  });

  it("uses placement.runtimePath for RunConfig.runtimePath", () => {
    const config = assembler.assemble({
      agentProviderConfig: AGENT_PROVIDER_CONFIG,
      placement: {
        runtimeType: "docker",
        isolationScope: "workspace",
        userId: "user-1",
        workspaceId: "ws-1",
        hostPath: "/tmp/ws",
        runtimePath: "/workspace",
        mountTarget: "/workspace",
      },
      workspaceId: "ws-1",
      runId: "run-1",
      conversationId: "conversation-1",
      input: {},
    });
    expect(config.runtimePath).toBe("/workspace");
  });

  it("adds local agent event trace config only when enabled", () => {
    vi.stubEnv("AGEWORK_AGENT_EVENT_TRACE_ENABLED", "true");
    vi.stubEnv("AGEWORK_AGENT_EVENT_TRACE_MAX_FILE_MB", "5");

    const config = assembler.assemble({
      agentProviderConfig: AGENT_PROVIDER_CONFIG,
      placement: {
        runtimeType: "local",
        isolationScope: "workspace",
        userId: "user-1",
        workspaceId: "ws-1",
        hostPath: "/tmp/ws",
        runtimePath: "/tmp/ws",
        mountTarget: "/tmp/ws",
      },
      workspaceId: "ws-1",
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
    const logDir = join("/tmp/agework-logs", "runtime");
    expect(config.agentEventTrace?.rawFilePath).toBe(
      join(logDir, "conversation-1.raw.jsonl")
    );
    expect(config.agentEventTrace?.rawRuntimeFilePath).toBe(
      join(logDir, "conversation-1.raw.jsonl")
    );
    expect(config.agentEventTrace?.aguiFilePath).toBe(
      join(logDir, "conversation-1.agui.jsonl")
    );
    expect(config.agentEventTrace?.rawFilePath).not.toContain(join("/tmp/ws"));
    expect(config.workerLogFilePath).toBe(
      join(logDir, "conversation-1.worker.log")
    );
  });
});
