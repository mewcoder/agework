import { describe, it, expect, vi, beforeEach } from "vitest";
import { BadRequestException } from "@nestjs/common";
import { AgentService } from "./agent.service";
import { AgentSpecBuilder } from "./agent-spec.builder";
import { ConversationService } from "../conversations/conversation.service";
import { RunService } from "../runs/run.service";
import type { Response } from "express";
import type { JwtUser } from "../auth/current-user.decorator";

describe("AgentService", () => {
  let service: AgentService;
  let mockAgentSpecBuilder: Partial<AgentSpecBuilder>;
  let mockConversationService: Partial<ConversationService>;
  let mockRunService: Partial<RunService>;
  let res: Partial<Response>;
  let user: JwtUser;

  beforeEach(() => {
    mockAgentSpecBuilder = {
      build: vi.fn().mockResolvedValue({
        agentType: "claude",
        adapter: { kind: "claude", isEnvironmentConfig: true },
      }),
    };
    mockConversationService = {
      findOne: vi.fn().mockResolvedValue({
        agentType: "claude",
        agentSessionId: undefined,
        workspaceId: "proj-1",
        activeRunStatus: "idle",
      }),
      getWorkspaceInfo: vi.fn().mockResolvedValue({
        rootPath: "/rootPath",
        runtimeType: "local",
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
      mockAgentSpecBuilder as AgentSpecBuilder,
      mockConversationService as ConversationService,
      mockRunService as RunService
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
    expect(mockRunService.start).not.toHaveBeenCalled();
  });

  it("throws BadRequestException when modelProviderId is missing", async () => {
    await expect(
      service.run(baseBody({ forwardedProps: {} }), res as Response, user)
    ).rejects.toThrow(BadRequestException);
  });

  it("wraps AgentSpec build errors as BadRequestException", async () => {
    mockAgentSpecBuilder.build = vi
      .fn()
      .mockRejectedValue(new Error("模型服务不可用"));

    await expect(
      service.run(baseBody(), res as Response, user)
    ).rejects.toThrow(BadRequestException);
  });

  it("builds the AgentSpec and delegates to RunService.start with a StartRunInput", async () => {
    const body = baseBody();

    await service.run(body, res as Response, user);

    expect(mockAgentSpecBuilder.build).toHaveBeenCalledWith(
      expect.objectContaining({ agentType: "claude", modelProviderId: "mc-1" })
    );

    expect(mockRunService.start).toHaveBeenCalledTimes(1);
    const startArgs = (mockRunService.start as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(startArgs.conversationId).toBe("conversation-1");
    expect(startArgs.userId).toBe("user-1");
    expect(startArgs.modelProviderId).toBe("mc-1");
    expect(startArgs.userMessageId).toBe("msg-1");
    expect(startArgs.res).toBe(res);
    expect(startArgs.agentSpec).toEqual(
      expect.objectContaining({ agentType: "claude" })
    );
    expect(startArgs.workspace).toEqual(
      expect.objectContaining({
        workspaceId: "proj-1",
        workspaceRootPath: "/rootPath",
        runtimeType: "local",
      })
    );
    expect(startArgs.input.forwardedProps.agentType).toBe("claude");
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
    expect(startArgs.input.messages).toEqual([body.messages[0]]);
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

  describe("resumeStream()", () => {
    it("verifies ownership then delegates to RunService.resumeStream", async () => {
      await service.resumeStream("conversation-1", res as Response, user);
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
        service.resumeStream("", res as Response, user)
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe("reply()", () => {
    it("delegates to RunService.resolveApproval", async () => {
      await service.reply("conversation-1", { q1: "yes" });
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
