import { describe, it, expect, vi, beforeEach } from "vitest";
import { BadRequestException } from "@nestjs/common";
import { AgentService } from "./agent.service";
import { ConversationService } from "../conversation.service";
import { RunService } from "../../runs/run.service";
import { ModelProviderService } from "../../model-providers/model-provider.service";
import type { Response } from "express";
import type { JwtUser } from "../../auth/current-user.decorator";
import type { AgentRunRequestBody } from "./agent.types";

describe("AgentService", () => {
  let service: AgentService;
  let mockConversationService: Partial<ConversationService>;
  let mockRunService: Partial<RunService>;
  let mockModelProviderService: Partial<ModelProviderService>;
  let res: Partial<Response>;
  let user: JwtUser;

  beforeEach(() => {
    mockModelProviderService = {
      resolveEnabledProvider: vi.fn().mockResolvedValue({
        source: "system",
      }),
    };
    mockConversationService = {
      findOne: vi.fn().mockResolvedValue({
        agentType: "claude",
        agentSessionId: undefined,
        workspaceId: "proj-1",
        activeRunStatus: "idle",
      }),
    };
    mockRunService = {
      start: vi.fn().mockResolvedValue(undefined),
      resumeStream: vi.fn().mockResolvedValue(undefined),
      resolveApproval: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(false),
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
      mockModelProviderService as ModelProviderService
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
    mockConversationService.findOne = vi.fn().mockResolvedValue({
      agentType: "claude",
      agentSessionId: undefined,
      workspaceId: undefined,
      activeRunStatus: "idle",
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

    expect(mockModelProviderService.resolveEnabledProvider).toHaveBeenCalledWith(
      "claude",
      "mc-1"
    );

    expect(mockRunService.start).toHaveBeenCalledTimes(1);
    const startArgs = (mockRunService.start as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(startArgs.conversationId).toBe("conversation-1");
    expect(startArgs.userId).toBe("user-1");
    expect(startArgs.modelProviderId).toBe("mc-1");
    expect(startArgs.workspaceId).toBe("proj-1");
    expect(startArgs.userMessageId).toBe("msg-1");
    expect(startArgs.res).toBe(res);
    expect(startArgs.agentProviderConfig).toEqual(
      expect.objectContaining({ agentType: "claude", source: "system" })
    );
    expect(startArgs.input.forwardedProps.agentType).toBe("claude");
  });

  it("passes a custom agent provider config to RunService.start", async () => {
    mockModelProviderService.resolveEnabledProvider = vi.fn().mockResolvedValue({
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
    mockModelProviderService.resolveEnabledProvider = vi.fn().mockResolvedValue({
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

  it("passes resume props when the conversation has an agentSessionId", async () => {
    mockConversationService.findOne = vi.fn().mockResolvedValue({
      agentType: "claude",
      agentSessionId: "session-1",
      workspaceId: "proj-1",
      activeRunStatus: "idle",
    });
    const body = baseBody();

    await service.run(body, res as Response, user);

    const startArgs = (mockRunService.start as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(startArgs.input.forwardedProps.agentSessionId).toBe("session-1");
    expect(startArgs.input.forwardedProps.resume).toBe("session-1");
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
    expect(startArgs.interruptReason).toBe("user_steered");
  });

  describe("resume()", () => {
    it("verifies ownership then delegates to RunService.resumeStream", async () => {
      await service.resume("conversation-1", res as Response, user);
      expect(mockConversationService.findOne).toHaveBeenCalledWith(
        "user-1",
        "conversation-1"
      );
      expect(mockRunService.resumeStream).toHaveBeenCalledWith(
        "conversation-1",
        res
      );
    });

    it("throws when conversationId is missing", async () => {
      await expect(
        service.resume("", res as Response, user)
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe("reply()", () => {
    it("verifies ownership then delegates to RunService.resolveApproval", async () => {
      await service.reply("conversation-1", { q1: "yes" }, user);
      expect(mockConversationService.findOne).toHaveBeenCalledWith(
        "user-1",
        "conversation-1"
      );
      expect(mockRunService.resolveApproval).toHaveBeenCalledWith(
        "conversation-1",
        { q1: "yes" }
      );
    });
  });

  describe("stop()", () => {
    it("resets a stale running conversation to idle when no in-memory handle existed", async () => {
      mockConversationService.findOne = vi
        .fn()
        .mockResolvedValue({ activeRunStatus: "running" });
      mockConversationService.setActiveRunStatus = vi
        .fn()
        .mockResolvedValue({ count: 1 });
      mockRunService.stop = vi.fn().mockResolvedValue(false);

      await service.stop("conversation-1", user);

      expect(mockRunService.stop).toHaveBeenCalledWith("conversation-1");
      expect(mockConversationService.setActiveRunStatus).toHaveBeenCalledWith(
        "conversation-1",
        "idle"
      );
    });

    it("does not reset status when an active handle was stopped", async () => {
      mockConversationService.findOne = vi
        .fn()
        .mockResolvedValue({ activeRunStatus: "running" });
      mockConversationService.setActiveRunStatus = vi
        .fn()
        .mockResolvedValue({ count: 1 });
      mockRunService.stop = vi.fn().mockResolvedValue(true);

      await service.stop("conversation-1", user);

      expect(mockConversationService.setActiveRunStatus).not.toHaveBeenCalled();
    });
  });
});
