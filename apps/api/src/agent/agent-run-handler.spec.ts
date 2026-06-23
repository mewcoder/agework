import { describe, it, expect, vi, beforeEach } from "vitest";
import { BadRequestException } from "@nestjs/common";
import { AgentRunHandler } from "./agent-run-handler";
import { AgentSpecBuilder } from "./agent-spec.builder";
import { RunConfigAssembler } from "../runs/run-config.assembler";
import { TitleService } from "./title.service";
import { ConversationService } from "../conversations/conversation.service";
import { RunService } from "../runs/run.service";
import { RuntimePlacementPolicy } from "../runtime/core/runtime-resources/runtime-placement.policy";
import { RunMessageAggregator } from "../runs/execution/run-message.aggregator";
import { ConfigService } from "../config/config.service";
import type { Response } from "express";
import type { JwtUser } from "../auth/current-user.decorator";

describe("AgentRunHandler", () => {
  let service: AgentRunHandler;
  let mockAgentSpecBuilder: Partial<AgentSpecBuilder>;
  let mockRunConfigAssembler: Partial<RunConfigAssembler>;
  let mockConversationService: Partial<ConversationService>;
  let mockTitleService: Partial<TitleService>;
  let mockRunRunner: Partial<RunService>;
  let mockRuntimePlacementPolicy: Partial<RuntimePlacementPolicy>;
  let mockConfigService: Partial<ConfigService>;
  let res: Partial<Response>;
  let user: JwtUser;

  beforeEach(() => {
    mockAgentSpecBuilder = {
      build: vi.fn().mockResolvedValue({
        agentType: "claude",
        adapter: { kind: "claude", isEnvironmentConfig: true },
      }),
    };
    mockRunConfigAssembler = {
      assemble: vi.fn().mockReturnValue({ runId: "run-1" }),
    };
    mockConversationService = {
      saveUserMessage: vi.fn().mockResolvedValue(undefined),
      findOne: vi.fn().mockResolvedValue({
        agentType: "claude",
        agentSessionId: undefined,
        workspaceId: "proj-1",
        activeRunStatus: "idle",
      }),
      getWorkspaceInfo: vi.fn().mockResolvedValue({ rootPath: "/rootPath" }),
      setActiveRunStatus: vi.fn().mockResolvedValue({ count: 1 }),
    };
    mockTitleService = {
      maybeGenerate: vi.fn().mockResolvedValue(undefined),
    };
    mockRunRunner = {
      start: vi.fn().mockResolvedValue(undefined),
    };
    mockRuntimePlacementPolicy = {
      resolveForRun: vi.fn().mockImplementation(({ userId, workspaceId, workspaceRootPath }) => ({
        runtimeType: "local",
        isolationScope: "user",
        userId,
        workspaceId,
        hostPath: workspaceRootPath,
        runtimePath: workspaceRootPath,
      })),
    };
    mockConfigService = {
      getDefaultRuntimeType: vi.fn().mockReturnValue("local"),
      getDefaultIsolationScope: vi.fn().mockReturnValue("user"),
      isRuntimeTypeAllowed: ((runtimeType: string): runtimeType is "local" | "sandbox" =>
        runtimeType === "local" || runtimeType === "sandbox"),
      isIsolationScopeAllowed: ((
        isolationScope: string
      ): isolationScope is "user" | "workspace" =>
        isolationScope === "user" ||
        isolationScope === "workspace"),
      getUserWorkspace: vi.fn().mockReturnValue("/rootPath-user"),
    };
    res = {
      setHeader: vi.fn(),
      on: vi.fn(),
      writableEnded: false,
      end: vi.fn(),
      write: vi.fn(),
    };
    user = { userId: "user-1" } as JwtUser;

    service = new AgentRunHandler(
      mockAgentSpecBuilder as AgentSpecBuilder,
      mockRunConfigAssembler as RunConfigAssembler,
      mockConversationService as ConversationService,
      mockTitleService as TitleService,
      mockRunRunner as RunService,
      mockRuntimePlacementPolicy as RuntimePlacementPolicy,
      mockConfigService as ConfigService
    );
  });

  // body.threadId 是 AG-UI 协议字段，值等于 AgeWork conversationId
  function baseBody(overrides: Record<string, unknown> = {}) {
    return {
      threadId: "conversation-1",
      messages: [{ id: "msg-1", role: "user", content: "hi" }],
      forwardedProps: { modelProviderId: "mc-1" },
      ...overrides,
    };
  }

  it("throws BadRequestException when conversation has no associated workspace", async () => {
    mockConversationService.getWorkspaceInfo = vi.fn().mockResolvedValue({});

    await expect(
      service.run(baseBody(), res as Response, user)
    ).rejects.toThrow(BadRequestException);
  });

  it("throws BadRequestException when modelProviderId is missing", async () => {
    await expect(
      service.run(baseBody({ forwardedProps: {} }), res as Response, user)
    ).rejects.toThrow(BadRequestException);
  });

  it("wraps run config build errors as BadRequestException", async () => {
    mockAgentSpecBuilder.build = vi
      .fn()
      .mockRejectedValue(new Error("模型服务不可用"));

    await expect(
      service.run(baseBody(), res as Response, user)
    ).rejects.toThrow(BadRequestException);
  });

  it("saves the user message and marks the conversation as running", async () => {
    const body = baseBody();

    await service.run(body, res as Response, user);

    expect(mockConversationService.saveUserMessage).toHaveBeenCalledWith(
      "conversation-1",
      body.messages[0]
    );
    expect(mockConversationService.setActiveRunStatus).toHaveBeenCalledWith(
      "conversation-1",
      "running"
    );
  });

  it("delegates to RunService.start with the built run config and lifecycle hooks", async () => {
    const body = baseBody();

    await service.run(body, res as Response, user);

    expect(mockAgentSpecBuilder.build).toHaveBeenCalledWith(
      expect.objectContaining({
        agentType: "claude",
        modelProviderId: "mc-1",
      })
    );
    expect(mockRunConfigAssembler.assemble).toHaveBeenCalledWith(
      expect.objectContaining({
        placement: expect.objectContaining({ runtimePath: "/rootPath" }),
        conversationId: "conversation-1",
      })
    );

    expect(mockRunRunner.start).toHaveBeenCalledTimes(1);
    const startArgs = (mockRunRunner.start as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(startArgs.conversationId).toBe("conversation-1");
    expect(startArgs.agentType).toBe("claude");
    expect(startArgs.userMessageId).toBe("msg-1");
    expect(startArgs.userId).toBe("user-1");
    expect(startArgs.runConfig).toEqual({ runId: "run-1" });
    expect(startArgs.res).toBe(res);
    expect(startArgs.aggregator).toBeInstanceOf(RunMessageAggregator);
    expect(typeof startArgs.saveRun).toBe("function");
    expect(typeof startArgs.onAgentSessionId).toBe("function");
  });

  it("resolves placement via RuntimePlacementPolicy and passes it to the assembler and runtimeRunner.start", async () => {
    const body = baseBody();

    await service.run(body, res as Response, user);

    expect(mockRuntimePlacementPolicy.resolveForRun).toHaveBeenCalledWith({
      userId: "user-1",
      workspaceId: "proj-1",
      workspaceRootPath: "/rootPath",
      userWorkspaceRootPath: "/rootPath-user",
      runtimeType: "local",
      isolationScope: undefined,
      sandboxEngine: undefined,
    });

    const assembleArgs = (
      mockRunConfigAssembler.assemble as ReturnType<typeof vi.fn>
    ).mock.calls[0][0];
    const startArgs = (mockRunRunner.start as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(assembleArgs.placement).toBe(startArgs.placement);
    expect(assembleArgs.placement.runtimePath).toBe("/rootPath");
  });

  it("passes resume props when the conversation has an agentSessionId", async () => {
    mockConversationService.findOne = vi.fn().mockResolvedValue({
      agentType: "claude",
      agentSessionId: "session-1",
      workspaceId: "proj-1",
      activeRunStatus: "idle",
    });
    const body = baseBody();

    await service.run(body, res as Response, user);

    const assembleArgs = (
      mockRunConfigAssembler.assemble as ReturnType<typeof vi.fn>
    ).mock.calls[0][0];
    expect(assembleArgs.input.forwardedProps.agentSessionId).toBe("session-1");
    expect(assembleArgs.input.forwardedProps.resume).toBe("session-1");
    expect(assembleArgs.input.messages).toEqual([body.messages[0]]);
  });

  it("uses the workspace runtime type when resolving placement", async () => {
    mockConversationService.findOne = vi.fn().mockResolvedValue({
      agentType: "claude",
      agentSessionId: "session-1",
      workspaceId: "proj-1",
      activeRunStatus: "idle",
    });
    mockRuntimePlacementPolicy.resolveForRun = vi
      .fn()
      .mockImplementation(({ userId, workspaceId, workspaceRootPath, runtimeType }) => ({
        runtimeType,
        isolationScope: "workspace",
        userId,
        workspaceId,
        hostPath: workspaceRootPath,
        runtimePath: "/workspace",
      }));
    mockConversationService.getWorkspaceInfo = vi.fn().mockResolvedValue({
      rootPath: "/tmp/ws",
      runtimeType: "sandbox",
      isolationScope: "workspace",
      sandboxEngine: "opensandbox",
    });
    const body = baseBody();

    await service.run(body, res as Response, user);

    const assembleArgs = (
      mockRunConfigAssembler.assemble as ReturnType<typeof vi.fn>
    ).mock.calls[0][0];
    expect(assembleArgs.input.forwardedProps.agentSessionId).toBe("session-1");
    expect(assembleArgs.input.forwardedProps.resume).toBe("session-1");
    const startArgs = (mockRunRunner.start as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(mockRuntimePlacementPolicy.resolveForRun).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeType: "sandbox",
        isolationScope: "workspace",
        sandboxEngine: "opensandbox",
      })
    );
    expect(startArgs.placement.runtimeType).toBe("sandbox");
  });

  it("rejects runs when the workspace runtime type is not allowed by deployment config", async () => {
    mockConversationService.getWorkspaceInfo = vi.fn().mockResolvedValue({
      rootPath: "/tmp/ws",
      runtimeType: "sandbox",
    });
    mockConfigService.isRuntimeTypeAllowed = ((
      _runtimeType: string
    ): _runtimeType is "local" | "sandbox" => false);

    await expect(
      service.run(baseBody(), res as Response, user)
    ).rejects.toThrow("当前部署不支持该工作空间的运行环境");

    expect(mockRuntimePlacementPolicy.resolveForRun).not.toHaveBeenCalled();
  });

  it("rejects runs when the workspace isolation scope is not allowed by deployment config", async () => {
    mockConversationService.getWorkspaceInfo = vi.fn().mockResolvedValue({
      rootPath: "/tmp/ws",
      runtimeType: "sandbox",
      isolationScope: "workspace",
    });
    mockConfigService.isIsolationScopeAllowed = ((
      _isolationScope: string
    ): _isolationScope is "user" | "workspace" => false);

    await expect(
      service.run(baseBody(), res as Response, user)
    ).rejects.toThrow("当前部署不支持该工作空间的隔离级别");

    expect(mockRuntimePlacementPolicy.resolveForRun).not.toHaveBeenCalled();
  });
});
