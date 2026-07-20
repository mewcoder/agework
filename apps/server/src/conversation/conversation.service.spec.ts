import { ConversationService } from "./conversation.service";

const mockUserId = "user-1";

function makeRepo(overrides: Record<string, unknown> = {}) {
  return {
    findByOwner: vi.fn().mockResolvedValue([]),
    findRegularByOwner: vi.fn().mockResolvedValue([]),
    findMessagesForConversations: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
    findOwnedById: vi.fn().mockResolvedValue(null),
    findRunStatusesByOwner: vi.fn().mockResolvedValue([]),
    setAgentSessionId: vi.fn().mockResolvedValue(undefined),
    findContentsByConversation: vi.fn().mockResolvedValue([]),
    findTitle: vi.fn().mockResolvedValue(null),
    updateTitle: vi.fn().mockResolvedValue(undefined),
    renameOwned: vi.fn().mockResolvedValue(undefined),
    updateOwned: vi.fn().mockResolvedValue(undefined),
    claimRun: vi.fn().mockResolvedValue(true),
    handoffRun: vi.fn().mockResolvedValue(true),
    setRunStateForOwner: vi.fn().mockResolvedValue(true),
    reconcileRunStateWithoutActiveRun: vi.fn().mockResolvedValue(true),
    attachMessageToRun: vi.fn().mockResolvedValue({ count: 1 }),
    archiveOwned: vi.fn().mockResolvedValue(undefined),
    unarchiveOwned: vi.fn().mockResolvedValue(undefined),
    softDeleteOwned: vi.fn().mockResolvedValue(undefined),
    deleteByWorkspace: vi.fn().mockResolvedValue(undefined),
    clearArchivedOwned: vi.fn().mockResolvedValue(undefined),
    findMessages: vi.fn().mockResolvedValue([]),
    upsertMessage: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("ConversationService", () => {
  it("claims the Conversation projection for the starting run", async () => {
    const repo = makeRepo();
    const service = new ConversationService(repo as never);

    await expect(
      service.activateConversation("conversation-1", "user-1", "run-1")
    ).resolves.toBe(true);
    expect(repo.claimRun).toHaveBeenCalledWith("conversation-1", "run-1");
  });

  it("hands the Conversation projection to the steering run", async () => {
    const repo = makeRepo();
    const service = new ConversationService(repo as never);

    await expect(
      service.handoffConversationRun(
        "conversation-1",
        "user-1",
        "run-old",
        "run-new"
      )
    ).resolves.toBe(true);
    expect(repo.handoffRun).toHaveBeenCalledWith(
      "conversation-1",
      "run-old",
      "run-new"
    );
  });

  it("updates run state through the activeRunId owner guard", async () => {
    const repo = makeRepo();
    const service = new ConversationService(repo as never);

    await expect(
      service.setConversationRunStateForRun("conversation-1", "run-1", {
        runStatus: "idle",
      })
    ).resolves.toBe(true);
    expect(repo.setRunStateForOwner).toHaveBeenCalledWith(
      "conversation-1",
      "run-1",
      { runStatus: "idle" }
    );
  });

  it("lists conversations by newest update time and maps to dto", async () => {
    const createdAt = new Date("2026-05-30T10:00:00.000Z");
    const updatedAt = new Date("2026-05-31T10:00:00.000Z");
    const repo = makeRepo({
      findByOwner: vi.fn().mockResolvedValue([
        {
          id: "conversation-new",
          status: "regular",
          runStatus: "idle",
          pendingUserAction: null,
          title: "New conversation",
          workspaceId: "workspace-1",
          agentType: "claude",
          agentSessionId: null,
          createdAt,
          updatedAt,
        },
      ]),
    });
    const service = new ConversationService(repo as never);

    const result = await service.list(mockUserId);

    expect(repo.findByOwner).toHaveBeenCalledWith(
      mockUserId,
      expect.objectContaining({
        status: "regular",
        sortKey: "updatedAt",
        take: 50,
      })
    );
    expect(result.list).toEqual([
      {
        status: "regular",
        runStatus: "idle",
        pendingUserAction: null,
        conversationId: "conversation-new",
        title: "New conversation",
        workspaceId: "workspace-1",
        agentType: "claude",
        createdAt: createdAt.toISOString(),
        updatedAt: updatedAt.toISOString(),
      },
    ]);
  });

  it("saves fallback user messages in assistant-ui format", async () => {
    const repo = makeRepo();
    const service = new ConversationService(repo as never);

    await service.saveUserMessage("conversation-1", {
      id: "user-1",
      content: "hello",
    });

    expect(repo.upsertMessage).toHaveBeenCalledWith(
      "conversation-1",
      expect.objectContaining({
        id: "user-1",
        parent_id: null,
        format: "assistant-ui",
        content: expect.objectContaining({
          id: "user-1",
          role: "user",
          content: [{ type: "text", text: "hello" }],
        }),
      })
    );
  });

  it("saves assistant snapshots with the envelope built here (row id = runId)", async () => {
    const repo = makeRepo();
    const service = new ConversationService(repo as never);

    await service.saveAssistantMessage("conversation-1", "run-1", {
      messageId: "srv-msg-1",
      content: [{ type: "text", text: "hi" }],
      status: { type: "complete" },
      metadata: { custom: { agui: {} } },
    });

    expect(repo.upsertMessage).toHaveBeenCalledWith("conversation-1", {
      id: "run-1",
      runId: "run-1",
      parent_id: null,
      format: "assistant-ui",
      content: {
        role: "assistant",
        id: "srv-msg-1",
        content: [{ type: "text", text: "hi" }],
        status: { type: "complete" },
        metadata: { custom: { agui: {} } },
      },
    });
  });

  it("falls back to runId as the content id when the snapshot has no messageId", async () => {
    const repo = makeRepo();
    const service = new ConversationService(repo as never);

    await service.saveAssistantMessage("conversation-1", "run-1", {
      messageId: undefined,
      content: [{ type: "text", text: "hi" }],
      status: { type: "running" },
    });

    expect(repo.upsertMessage).toHaveBeenCalledWith(
      "conversation-1",
      expect.objectContaining({
        content: expect.objectContaining({ id: "run-1" }),
      })
    );
  });

  it("skips persisting empty assistant snapshots", async () => {
    const repo = makeRepo();
    const service = new ConversationService(repo as never);

    await service.saveAssistantMessage("conversation-1", "run-1", {
      messageId: undefined,
      content: [],
      status: { type: "running" },
    });

    expect(repo.upsertMessage).not.toHaveBeenCalled();
  });

  it("attaches an existing message to a run", async () => {
    const repo = makeRepo();
    const service = new ConversationService(repo as never);

    await expect(
      service.attachMessageToRun("conversation-1", "msg-1", "run-1")
    ).resolves.toEqual({ count: 1 });

    expect(repo.attachMessageToRun).toHaveBeenCalledWith(
      "conversation-1",
      "msg-1",
      "run-1"
    );
  });

  it("soft deletes conversations for a deleted workspace through the conversation repository", async () => {
    const repo = makeRepo();
    const service = new ConversationService(repo as never);
    const deletedAt = new Date("2026-06-29T10:00:00.000Z");

    await service.deleteByWorkspace("workspace-1", deletedAt);

    expect(repo.deleteByWorkspace).toHaveBeenCalledWith(
      "workspace-1",
      deletedAt
    );
  });

  it("generates an AI title from the first stored user message", async () => {
    const titleService = {
      generateLLMTitle: vi.fn().mockResolvedValue("重构参数校验"),
    };
    const repo = makeRepo({
      findContentsByConversation: vi.fn().mockResolvedValue([
        {
          content: {
            role: "user",
            content: [{ type: "text", text: "帮我重构参数校验" }],
          },
        },
      ]),
    });
    const service = new ConversationService(
      repo as never,
      titleService as never
    );

    await service.saveUserMessage(
      "conversation-1",
      { id: "msg-1", content: "帮我重构参数校验" },
      { agentType: "claude", modelProviderId: "mp-1" }
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(titleService.generateLLMTitle).toHaveBeenCalledWith({
      agentType: "claude",
      modelProviderId: "mp-1",
      userText: "帮我重构参数校验",
    });
    expect(repo.updateTitle).toHaveBeenCalledWith(
      "conversation-1",
      "重构参数校验"
    );
  });

  it("skips AI title generation after multiple stored user messages", async () => {
    const titleService = {
      generateLLMTitle: vi.fn().mockResolvedValue("不会生成"),
    };
    const repo = makeRepo({
      findContentsByConversation: vi
        .fn()
        .mockResolvedValue([
          { content: { role: "user", content: "first" } },
          { content: { role: "assistant", content: "reply" } },
          { content: { role: "user", content: "second" } },
        ]),
    });
    const service = new ConversationService(
      repo as never,
      titleService as never
    );

    await service.saveUserMessage(
      "conversation-1",
      { id: "msg-1", content: "first" },
      { agentType: "claude", modelProviderId: "mp-1" }
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(titleService.generateLLMTitle).not.toHaveBeenCalled();
  });

  it("normalizes message format and fills parent_id from previous message order", async () => {
    const repo = makeRepo({
      findOwnedById: vi
        .fn()
        .mockResolvedValue({ id: "conversation-1", workspaceId: "p-1" }),
      findMessages: vi.fn().mockResolvedValue([
        {
          id: "user-1",
          parentId: null,
          format: "ag-ui",
          content: { id: "user-1", role: "user", content: "hello" },
        },
        {
          id: "user-2",
          parentId: null,
          format: "assistant-ui",
          content: { id: "user-2", role: "user", content: "next" },
        },
      ]),
    });
    const service = new ConversationService(repo as never);

    await expect(
      service.listMessages(mockUserId, "conversation-1")
    ).resolves.toEqual({
      list: [
        {
          id: "user-1",
          parent_id: null,
          format: "assistant-ui",
          content: { id: "user-1", role: "user", content: "hello" },
        },
        {
          id: "user-2",
          parent_id: "user-1",
          format: "assistant-ui",
          content: { id: "user-2", role: "user", content: "next" },
        },
      ],
    });
  });

  describe("search", () => {
    function makeConversation(
      overrides: Partial<{
        id: string;
        title: string | null;
        status: string;
        workspaceId: string;
      }> = {}
    ) {
      return {
        id: "conv-1",
        status: "regular",
        runStatus: "idle",
        pendingUserAction: null,
        title: "hello world",
        workspaceId: "ws-1",
        agentType: "claude",
        agentSessionId: null,
        createdAt: new Date("2026-06-01T00:00:00.000Z"),
        updatedAt: new Date("2026-06-18T00:00:00.000Z"),
        ...overrides,
      };
    }

    it("returns empty list for blank query", async () => {
      const service = new ConversationService(makeRepo() as never);
      const result = await service.search(mockUserId, "   ");
      expect(result.list).toEqual([]);
    });

    it("matches conversation title and returns a snippet without scanning messages", async () => {
      const repo = makeRepo({
        findRegularByOwner: vi
          .fn()
          .mockResolvedValue([
            makeConversation({ id: "c-title", title: "Refactor auth module" }),
          ]),
      });
      const service = new ConversationService(repo as never);

      const result = await service.search(mockUserId, "auth");

      expect(result.list).toHaveLength(1);
      expect(result.list[0].matchedField).toBe("title");
      expect(result.list[0].conversation.conversationId).toBe("c-title");
      expect(result.list[0].matchedSnippet.toLowerCase()).toContain("auth");
      expect(repo.findMessagesForConversations).not.toHaveBeenCalled();
    });

    it("matches message content when title does not match", async () => {
      const repo = makeRepo({
        findRegularByOwner: vi
          .fn()
          .mockResolvedValue([
            makeConversation({ id: "c-msg", title: "untitled" }),
          ]),
        findMessagesForConversations: vi.fn().mockResolvedValue([
          {
            id: "m-1",
            conversationId: "c-msg",
            content: {
              id: "m-1",
              role: "user",
              content: [
                { type: "text", text: "How do I deploy to production?" },
              ],
            },
          },
        ]),
      });
      const service = new ConversationService(repo as never);

      const result = await service.search(mockUserId, "production");

      expect(result.list).toHaveLength(1);
      expect(result.list[0].matchedField).toBe("message");
      expect(result.list[0].matchedSnippet.toLowerCase()).toContain(
        "production"
      );
    });

    it("clamps the conversation fetch window", async () => {
      const repo = makeRepo();
      const service = new ConversationService(repo as never);

      await service.search(mockUserId, "x", 9999);

      expect(repo.findRegularByOwner).toHaveBeenCalledWith(mockUserId, 200);
    });

    it("builds snippet with ellipsis when match is not at text boundary", async () => {
      const longTitle = "a".repeat(80) + "target" + "b".repeat(80);
      const repo = makeRepo({
        findRegularByOwner: vi
          .fn()
          .mockResolvedValue([
            makeConversation({ id: "c-snip", title: longTitle }),
          ]),
      });
      const service = new ConversationService(repo as never);

      const result = await service.search(mockUserId, "target");
      const snippet = result.list[0].matchedSnippet;

      expect(snippet).toContain("target");
      expect(snippet.startsWith("…")).toBe(true);
      expect(snippet.endsWith("…")).toBe(true);
    });
  });

  // 资源归属：所有按 id 的读写都必须经过 repo 的 owner 限定方法（owner where 细节在 repo spec 锁）。
  describe("ownership scoping", () => {
    it("findOne delegates to the owner-scoped lookup and 404s when not owned", async () => {
      const repo = makeRepo({ findOwnedById: vi.fn().mockResolvedValue(null) });
      const service = new ConversationService(repo as never);

      await expect(service.findById(mockUserId, "conv-x")).rejects.toThrow(
        "对话不存在"
      );
      expect(repo.findOwnedById).toHaveBeenCalledWith(mockUserId, "conv-x");
    });

    it.each([
      ["delete", "softDeleteOwned"],
      ["archive", "archiveOwned"],
      ["unarchive", "unarchiveOwned"],
    ] as const)(
      "%s routes through the owner-scoped repository method",
      async (method, repoMethod) => {
        const repo = makeRepo();
        const service = new ConversationService(repo as never);

        await (
          service as unknown as Record<
            string,
            (a: string, b: string) => Promise<void>
          >
        )[method](mockUserId, "conv-x");

        expect(repo[repoMethod]).toHaveBeenCalledWith(mockUserId, "conv-x");
      }
    );

    it("listMessages returns nothing for a conversation the caller does not own", async () => {
      const repo = makeRepo({ findOwnedById: vi.fn().mockResolvedValue(null) });
      const service = new ConversationService(repo as never);

      const result = await service.listMessages(mockUserId, "conv-x");

      expect(result).toEqual({ list: [] });
      expect(repo.findMessages).not.toHaveBeenCalled();
    });
  });
});
