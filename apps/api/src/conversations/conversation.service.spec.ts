vi.mock("../prisma/prisma.service", () => ({
  PrismaService: class PrismaService {},
}));

import { ConversationService } from "./conversation.service";

const mockUserId = "user-1";

describe("ConversationService", () => {
  it("lists conversations by newest update time and includes updatedAt", async () => {
    const createdAt = new Date("2026-05-30T10:00:00.000Z");
    const updatedAt = new Date("2026-05-31T10:00:00.000Z");
    const findMany = vi.fn().mockResolvedValue([
      {
        id: "conversation-new",
        status: "regular",
        activeRunStatus: "idle",
        pendingUserAction: null,
        title: "New conversation",
        workspaceId: "workspace-1",
        agentType: "claude",
        agentSessionId: null,
        createdAt,
        updatedAt,
      },
    ]);
    const service = new ConversationService({
      conversation: { findMany },
    } as never);

    const result = await service.list(mockUserId);

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: { updatedAt: "desc" },
        take: 50,
      })
    );
    expect(result.list).toEqual([
      {
        status: "regular",
        activeRunStatus: "idle",
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
    const upsert = vi.fn().mockResolvedValue(undefined);
    const update = vi.fn().mockResolvedValue(undefined);
    const service = new ConversationService({
      message: {
        findUnique: vi.fn().mockResolvedValue(null),
        findFirst: vi.fn().mockResolvedValue(null),
        upsert,
      },
      conversation: { update },
    } as never);

    await service.saveUserMessage("conversation-1", {
      id: "user-1",
      content: "hello",
    });

    const create = upsert.mock.calls[0][0].create;
    expect(create.format).toBe("assistant-ui");
    expect(create.parentId).toBeNull();
    expect(create.runId).toBeNull();
    expect(create.content).toMatchObject({
      id: "user-1",
      role: "user",
      content: [{ type: "text", text: "hello" }],
    });
  });

  it("attaches an existing message to a run", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const service = new ConversationService({
      message: { updateMany },
    } as never);

    await expect(
      service.attachMessageToRun("conversation-1", "msg-1", "run-1")
    ).resolves.toEqual({ count: 1 });

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "msg-1", conversationId: "conversation-1" },
      data: { runId: "run-1" },
    });
  });

  it("generates an AI title from the first stored user message", async () => {
    const titleService = {
      generateTitle: vi.fn().mockResolvedValue("重构参数校验"),
    };
    const findMany = vi.fn().mockResolvedValue([
      {
        content: {
          role: "user",
          content: [{ type: "text", text: "帮我重构参数校验" }],
        },
      },
    ]);
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const service = new ConversationService(
      {
        message: { findMany },
        conversation: { updateMany },
      } as never,
      titleService as never
    );

    await service.generateTitleIfNeeded({
      conversationId: "conversation-1",
      agentType: "claude",
      modelProviderId: "mp-1",
    });

    expect(titleService.generateTitle).toHaveBeenCalledWith({
      agentType: "claude",
      modelProviderId: "mp-1",
      userText: "帮我重构参数校验",
    });
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "conversation-1", deletedAt: null },
      data: { title: "重构参数校验" },
    });
  });

  it("skips AI title generation after multiple stored user messages", async () => {
    const titleService = {
      generateTitle: vi.fn().mockResolvedValue("不会生成"),
    };
    const service = new ConversationService(
      {
        message: {
          findMany: vi.fn().mockResolvedValue([
            { content: { role: "user", content: "first" } },
            { content: { role: "assistant", content: "reply" } },
            { content: { role: "user", content: "second" } },
          ]),
        },
        conversation: { updateMany: vi.fn() },
      } as never,
      titleService as never
    );

    await service.generateTitleIfNeeded({
      conversationId: "conversation-1",
      agentType: "claude",
      modelProviderId: "mp-1",
    });

    expect(titleService.generateTitle).not.toHaveBeenCalled();
  });

  it("uses the previous message as parent when parent_id is missing", async () => {
    const upsert = vi.fn().mockResolvedValue(undefined);
    const service = new ConversationService({
      message: {
        findUnique: vi.fn().mockResolvedValue(null),
        findFirst: vi.fn().mockResolvedValue({ id: "assistant-1" }),
        upsert,
      },
      conversation: { update: vi.fn().mockResolvedValue(undefined) },
    } as never);

    await service.upsertMessage("conversation-1", {
      id: "user-2",
      runId: "run-1",
      parent_id: null,
      format: "assistant-ui",
      content: { id: "user-2", role: "user", content: "next" },
    });

    expect(upsert.mock.calls[0][0].create.parentId).toBe("assistant-1");
    expect(upsert.mock.calls[0][0].create.runId).toBe("run-1");
    expect(upsert.mock.calls[0][0].update.parentId).toBe("assistant-1");
    expect(upsert.mock.calls[0][0].update.runId).toBe("run-1");
  });

  it("returns effective parent ids for legacy root messages", async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        id: "user-1",
        parentId: null,
        format: "ag-ui",
        content: {
          id: "user-1",
          role: "user",
          content: "hello",
        },
      },
      {
        id: "user-2",
        parentId: null,
        format: "assistant-ui",
        content: {
          id: "user-2",
          role: "user",
          content: "next",
        },
      },
    ]);
    const service = new ConversationService({
      conversation: {
        findFirst: vi
          .fn()
          .mockResolvedValue({ id: "conversation-1", workspaceId: "p-1" }),
      },
      message: { findMany },
    } as never);

    await expect(
      service.listMessages(mockUserId, "conversation-1")
    ).resolves.toEqual([
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
    ]);
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
      const createdAt = new Date("2026-06-01T00:00:00.000Z");
      const updatedAt = new Date("2026-06-18T00:00:00.000Z");
      return {
        id: "conv-1",
        status: "regular",
        activeRunStatus: "idle",
        pendingUserAction: null,
        title: "hello world",
        workspaceId: "ws-1",
        agentType: "claude",
        agentSessionId: null,
        createdAt,
        updatedAt,
        ...overrides,
      };
    }

    it("returns empty list for blank query", async () => {
      const service = new ConversationService({} as never);
      const result = await service.search(mockUserId, "   ");
      expect(result.list).toEqual([]);
    });

    it("matches conversation title and returns a snippet", async () => {
      const findMany = vi
        .fn()
        .mockResolvedValue([
          makeConversation({ id: "c-title", title: "Refactor auth module" }),
        ]);
      const messageFindMany = vi.fn().mockResolvedValue([]);
      const service = new ConversationService({
        conversation: { findMany },
        message: { findMany: messageFindMany },
      } as never);

      const result = await service.search(mockUserId, "auth");

      expect(result.list).toHaveLength(1);
      const hit = result.list[0];
      expect(hit.matchedField).toBe("title");
      expect(hit.conversation.conversationId).toBe("c-title");
      expect(hit.matchedSnippet.toLowerCase()).toContain("auth");
      // 标题命中后不应再扫描消息
      expect(messageFindMany).not.toHaveBeenCalled();
    });

    it("matches message content when title does not match", async () => {
      const findMany = vi
        .fn()
        .mockResolvedValue([
          makeConversation({ id: "c-msg", title: "untitled" }),
        ]);
      const messageFindMany = vi.fn().mockResolvedValue([
        {
          id: "m-1",
          conversationId: "c-msg",
          content: {
            id: "m-1",
            role: "user",
            content: [{ type: "text", text: "How do I deploy to production?" }],
          },
        },
      ]);
      const service = new ConversationService({
        conversation: { findMany },
        message: { findMany: messageFindMany },
      } as never);

      const result = await service.search(mockUserId, "production");

      expect(result.list).toHaveLength(1);
      const hit = result.list[0];
      expect(hit.matchedField).toBe("message");
      expect(hit.matchedSnippet.toLowerCase()).toContain("production");
    });

    it("skips archived conversations", async () => {
      const findMany = vi
        .fn()
        .mockImplementation((args: { where?: { status?: string } }) =>
          Promise.resolve(
            args.where?.status === "regular" ? [] : [makeConversation()]
          )
        );
      const service = new ConversationService({
        conversation: { findMany },
        message: { findMany: vi.fn().mockResolvedValue([]) },
      } as never);

      const result = await service.search(mockUserId, "hello");

      // service.search 应只查 status=regular，归档会话不会出现在结果里
      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: "regular" }),
        })
      );
      expect(result.list).toEqual([]);
    });

    it("clamps limit to max 50", async () => {
      const findMany = vi.fn().mockResolvedValue([]);
      const service = new ConversationService({
        conversation: { findMany },
      } as never);

      await service.search(mockUserId, "x", 9999);

      // take 上限是 200（conversation），最终结果切片上限 50
      expect(findMany.mock.calls[0][0]).toMatchObject({ take: 200 });
    });

    it("builds snippet with ellipsis when match is not at text boundary", async () => {
      const longTitle = "a".repeat(80) + "target" + "b".repeat(80);
      const findMany = vi
        .fn()
        .mockResolvedValue([
          makeConversation({ id: "c-snip", title: longTitle }),
        ]);
      const service = new ConversationService({
        conversation: { findMany },
        message: { findMany: vi.fn().mockResolvedValue([]) },
      } as never);

      const result = await service.search(mockUserId, "target");
      const snippet = result.list[0].matchedSnippet;

      expect(snippet).toContain("target");
      expect(snippet.startsWith("…")).toBe(true);
      expect(snippet.endsWith("…")).toBe(true);
    });
  });

  // 资源归属：所有按 id 的读写都必须限定在调用者自己的 workspace 下，
  // 否则别人的 conversationId 也能命中。这里锁死 where 里的 owner 过滤。
  describe("ownership scoping", () => {
    const ownerFilter = { userId: mockUserId, deletedAt: null };

    it("findOne scopes by workspace owner and 404s when not owned", async () => {
      const findFirst = vi.fn().mockResolvedValue(null);
      const service = new ConversationService({
        conversation: { findFirst },
      } as never);

      await expect(service.findOne(mockUserId, "conv-x")).rejects.toThrow(
        "对话不存在"
      );
      expect(findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: "conv-x",
            workspace: ownerFilter,
          }),
        })
      );
    });

    it.each([
      ["delete", (s: ConversationService) => s.delete(mockUserId, "conv-x")],
      ["archive", (s: ConversationService) => s.archive(mockUserId, "conv-x")],
      [
        "unarchive",
        (s: ConversationService) => s.unarchive(mockUserId, "conv-x"),
      ],
    ])("%s only touches conversations under the owner's workspace", async (
      _label,
      call
    ) => {
      const updateMany = vi.fn().mockResolvedValue({ count: 0 });
      const service = new ConversationService({
        conversation: { updateMany },
      } as never);

      await call(service);

      expect(updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ workspace: ownerFilter }),
        })
      );
    });

    it("listMessages returns nothing for a conversation the caller does not own", async () => {
      const findFirst = vi.fn().mockResolvedValue(null);
      const findMany = vi.fn();
      const service = new ConversationService({
        conversation: { findFirst },
        message: { findMany },
      } as never);

      const result = await service.listMessages(mockUserId, "conv-x");

      expect(result).toEqual([]);
      expect(findMany).not.toHaveBeenCalled();
    });
  });
});
