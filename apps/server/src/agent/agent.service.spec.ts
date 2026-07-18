import { describe, it, expect, vi, beforeEach } from "vitest";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { AgentService } from "./agent.service";
import { ConversationService } from "../conversation/conversation.service";
import { RunService } from "../run/run.service";
import { ModelProviderService } from "../model-provider/model-provider.service";
import { WorkspaceService } from "../workspace/workspace.service";
import { AgentSkillsScanner } from "./skills/agent-skills.scanner";
import type { Response } from "express";
import type { JwtUser } from "../auth/auth.types";
import type { AgentRunRequestDto as AgentRunRequestBody } from "./dto/agent-run.dto";

describe("AgentService", () => {
  let service: AgentService;
  let mockConversationService: Partial<ConversationService>;
  let mockRunService: Partial<RunService>;
  let mockModelProviderService: Partial<ModelProviderService>;
  let mockWorkspaceService: Partial<WorkspaceService>;
  let mockSkillsScanner: Partial<AgentSkillsScanner>;
  let res: Partial<Response>;
  let user: JwtUser;

  beforeEach(() => {
    mockModelProviderService = {
      resolveEnabledProvider: vi.fn().mockResolvedValue({
        source: "system",
      }),
    };
    mockConversationService = {
      findById: vi.fn().mockResolvedValue({
        agentType: "claude",
        agentSessionId: undefined,
        workspaceId: "proj-1",
        runStatus: "idle",
      }),
    };
    mockRunService = {
      start: vi.fn().mockResolvedValue(undefined),
      resume: vi.fn().mockResolvedValue(undefined),
      resumeWithAnswers: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(false),
    };
    mockWorkspaceService = {
      getRunContext: vi.fn().mockResolvedValue({
        workspaceId: "proj-1",
        workspaceRootPath: "/tmp/ws",
        runtimeType: "native",
        runtimeHostId: "builtin",
        username: "mew",
      }),
    };
    mockSkillsScanner = {
      scan: vi.fn().mockResolvedValue([]),
    };
    res = {
      setHeader: vi.fn(),
      on: vi.fn(),
      writableEnded: false,
      end: vi.fn(),
      write: vi.fn(),
    };
    user = { userId: "user-1" } as JwtUser;

    service = new AgentService(
      mockConversationService as ConversationService,
      mockRunService as RunService,
      mockModelProviderService as ModelProviderService,
      mockWorkspaceService as WorkspaceService,
      mockSkillsScanner as AgentSkillsScanner
    );
  });

  // body.threadId 是 AG-UI 协议字段，值等于 AgeWork conversationId
  function baseBody(
    overrides: Record<string, unknown> = {}
  ): AgentRunRequestBody {
    return {
      threadId: "conversation-1",
      runId: "run-1",
      messages: [{ id: "msg-1", content: "hi" }],
      forwardedProps: { agentType: "claude", modelProviderId: "mc-1" },
      ...overrides,
    };
  }

  it("throws BadRequestException when conversation has no associated workspace", async () => {
    mockConversationService.findById = vi.fn().mockResolvedValue({
      agentType: "claude",
      agentSessionId: undefined,
      workspaceId: undefined,
      runStatus: "idle",
    });

    await expect(
      service.run(baseBody(), res as Response, user)
    ).rejects.toThrow(BadRequestException);
    expect(mockRunService.start).not.toHaveBeenCalled();
  });

  it("throws BadRequestException when requested agentType does not match the conversation", async () => {
    await expect(
      service.run(
        baseBody({
          forwardedProps: { agentType: "codex", modelProviderId: "mc-1" },
        }),
        res as Response,
        user
      )
    ).rejects.toThrow(BadRequestException);
    expect(
      mockModelProviderService.resolveEnabledProvider
    ).not.toHaveBeenCalled();
    expect(mockRunService.start).not.toHaveBeenCalled();
  });

  it("wraps agent provider config lookup errors as BadRequestException", async () => {
    mockModelProviderService.resolveEnabledProvider = vi
      .fn()
      .mockRejectedValue(new Error("模型服务不可用"));

    await expect(
      service.run(baseBody(), res as Response, user)
    ).rejects.toThrow(BadRequestException);
  });

  it("gets the agent provider config and delegates to RunService.start with a StartRunInput", async () => {
    const body = baseBody();

    await service.run(body, res as Response, user);

    expect(
      mockModelProviderService.resolveEnabledProvider
    ).toHaveBeenCalledWith("claude", "mc-1");

    expect(mockRunService.start).toHaveBeenCalledTimes(1);
    const startArgs = (mockRunService.start as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(startArgs.conversationId).toBe("conversation-1");
    expect(startArgs.userId).toBe("user-1");
    expect(startArgs.modelProviderId).toBe("mc-1");
    expect(startArgs.workspace.workspaceId).toBe("proj-1");
    expect(startArgs.userMessageId).toBe("msg-1");
    expect(startArgs.agentProviderConfig).toEqual(
      expect.objectContaining({ agentType: "claude", source: "system" })
    );
    expect(startArgs.input.forwardedProps.agentType).toBe("claude");
  });

  it("passes a custom agent provider config to RunService.start", async () => {
    mockModelProviderService.resolveEnabledProvider = vi
      .fn()
      .mockResolvedValue({
        source: "custom",
        providerConfig: {
          baseUrl: "https://example.com",
          apiKey: "sk-test",
          models: ["claude-test"],
          extraConfig: { FOO: "bar" },
        },
      });

    await service.run(
      baseBody({
        forwardedProps: {
          agentType: "claude",
          modelProviderId: "mc-1",
          model: "claude-test",
        },
      }),
      res as Response,
      user
    );

    const startArgs = (mockRunService.start as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(startArgs.agentProviderConfig).toEqual({
      agentType: "claude",
      source: "custom",
      baseUrl: "https://example.com",
      apiKey: "sk-test",
      model: "claude-test",
      extraConfig: { FOO: "bar" },
    });
  });

  it("throws when the requested model is not available for a custom provider", async () => {
    mockModelProviderService.resolveEnabledProvider = vi
      .fn()
      .mockResolvedValue({
        source: "custom",
        providerConfig: {
          baseUrl: "https://example.com",
          apiKey: "sk-test",
          models: ["claude-test"],
          extraConfig: {},
        },
      });

    await expect(
      service.run(
        baseBody({
          forwardedProps: {
            agentType: "claude",
            modelProviderId: "mc-1",
            model: "claude-unknown",
          },
        }),
        res as Response,
        user
      )
    ).rejects.toThrow(BadRequestException);
  });

  it("passes agentSessionId through without per-agent resume mapping", async () => {
    mockConversationService.findById = vi.fn().mockResolvedValue({
      agentType: "claude",
      agentSessionId: "session-1",
      workspaceId: "proj-1",
      runStatus: "idle",
    });
    const body = baseBody();

    await service.run(body, res as Response, user);

    const startArgs = (mockRunService.start as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(startArgs.input.forwardedProps.agentSessionId).toBe("session-1");
    // 续接语义(claude 的 resume 等)由各 adapter 自己从 agentSessionId 派生
    expect(startArgs.input.forwardedProps.resume).toBeUndefined();
    expect(startArgs.input.messages).toEqual(body.messages?.slice(-1));
  });

  it("forwards interruptReason through to RunService.start", async () => {
    await service.run(
      baseBody({ interruptReason: "user_steered" }),
      res as Response,
      user
    );
    const startArgs = (mockRunService.start as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(startArgs.input.interruptReason).toBe("user_steered");
  });

  describe("resume()", () => {
    it("verifies ownership then delegates to RunService.resume", async () => {
      await service.resume("conversation-1", res as Response, user);
      expect(mockConversationService.findById).toHaveBeenCalledWith(
        "user-1",
        "conversation-1"
      );
      expect(mockRunService.resume).toHaveBeenCalledWith("conversation-1", res);
    });

    it("throws when conversationId is missing", async () => {
      await expect(service.resume("", res as Response, user)).rejects.toThrow(
        BadRequestException
      );
    });
  });

  describe("run() with resume[] (interrupt 答复续接)", () => {
    const resumeEntries = [
      {
        interruptId: "int-1",
        status: "resolved",
        payload: { answers: { q1: "yes" } },
      },
    ];

    it("verifies ownership then delegates to RunService.resumeWithAnswers, skipping launch", async () => {
      await service.run(
        baseBody({ runId: "run-2", resume: resumeEntries }),
        res as Response,
        user
      );

      expect(mockConversationService.findById).toHaveBeenCalledWith(
        "user-1",
        "conversation-1"
      );
      expect(mockRunService.resumeWithAnswers).toHaveBeenCalledWith({
        conversationId: "conversation-1",
        resumeRunId: "run-2",
        resume: resumeEntries,
        res,
      });
      expect(mockRunService.start).not.toHaveBeenCalled();
    });
  });

  describe("stop()", () => {
    it("resets a stale running conversation to idle when no in-memory handle existed", async () => {
      mockConversationService.findById = vi
        .fn()
        .mockResolvedValue({ runStatus: "running" });
      mockConversationService.setRunStatus = vi
        .fn()
        .mockResolvedValue({ count: 1 });
      mockRunService.stop = vi.fn().mockResolvedValue(false);

      await service.stop("conversation-1", user);

      expect(mockRunService.stop).toHaveBeenCalledWith("conversation-1");
      expect(mockConversationService.setRunStatus).toHaveBeenCalledWith(
        "conversation-1",
        "idle"
      );
    });

    it("does not reset status when an active handle was stopped", async () => {
      mockConversationService.findById = vi
        .fn()
        .mockResolvedValue({ runStatus: "running" });
      mockConversationService.setRunStatus = vi
        .fn()
        .mockResolvedValue({ count: 1 });
      mockRunService.stop = vi.fn().mockResolvedValue(true);

      await service.stop("conversation-1", user);

      expect(mockConversationService.setRunStatus).not.toHaveBeenCalled();
    });
  });

  // run 没有独立的用户接口，全部通过 conversationService.findById(userId, …) 做归属闸门。
  // 别人的 conversationId 会让 findById 抛 NotFound，后续 runService 一律不得被调用。
  describe("ownership gate (run access scoped to the caller)", () => {
    beforeEach(() => {
      mockConversationService.findById = vi
        .fn()
        .mockRejectedValue(new NotFoundException("对话不存在"));
    });

    it("run() with resume[] does not resolve approval for a conversation the caller does not own", async () => {
      await expect(
        service.run(
          baseBody({
            threadId: "conv-x",
            resume: [
              {
                interruptId: "int-1",
                status: "resolved",
                payload: { answers: {} },
              },
            ],
          }),
          res as Response,
          user
        )
      ).rejects.toThrow();
      expect(mockRunService.resumeWithAnswers).not.toHaveBeenCalled();
    });

    it("stop does not stop the run for a conversation the caller does not own", async () => {
      await expect(service.stop("conv-x", user)).rejects.toThrow();
      expect(mockRunService.stop).not.toHaveBeenCalled();
    });

    it("resume does not stream a conversation the caller does not own", async () => {
      await expect(
        service.resume("conv-x", res as Response, user)
      ).rejects.toThrow();
      expect(mockRunService.resume).not.toHaveBeenCalled();
    });
  });
});
