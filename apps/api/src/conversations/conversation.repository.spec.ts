import { ConversationRepository } from "./conversation.repository";

const ownerFilter = { userId: "user-1", deletedAt: null };

function makePrisma(parts: {
  conversation?: Record<string, unknown>;
  message?: Record<string, unknown>;
  workspace?: Record<string, unknown>;
}) {
  return {
    conversation: parts.conversation ?? {},
    message: parts.message ?? {},
    workspace: parts.workspace ?? {},
  };
}

describe("ConversationRepository", () => {
  it("findRegularByOwner filters to regular conversations under the owner's workspace", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const repo = new ConversationRepository(
      makePrisma({ conversation: { findMany } }) as never
    );

    await repo.findRegularByOwner("user-1", 200);

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: "regular",
          deletedAt: null,
          workspace: ownerFilter,
        }),
        take: 200,
      })
    );
  });

  it("findOwnedById scopes the lookup by the owner's workspace", async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const repo = new ConversationRepository(
      makePrisma({ conversation: { findFirst } }) as never
    );

    await repo.findOwnedById("user-1", "conv-x");

    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "conv-x",
          deletedAt: null,
          workspace: ownerFilter,
        }),
      })
    );
  });

  it.each([
    ["softDeleteOwned", { deletedAt: expect.any(Date) }],
    ["archiveOwned", { status: "archived" }],
    ["unarchiveOwned", { status: "regular" }],
  ] as const)(
    "%s only updates conversations under the owner's workspace",
    async (method, data) => {
      const updateMany = vi.fn().mockResolvedValue({ count: 0 });
      const repo = new ConversationRepository(
        makePrisma({ conversation: { updateMany } }) as never
      );

      await (repo as unknown as Record<string, (a: string, b: string) => Promise<void>>)[
        method
      ]("user-1", "conv-x");

      expect(updateMany).toHaveBeenCalledWith({
        where: { id: "conv-x", deletedAt: null, workspace: ownerFilter },
        data,
      });
    }
  );

  it("setActiveRunStatus guards the running transition and reports whether a row changed", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const repo = new ConversationRepository(
      makePrisma({ conversation: { updateMany } }) as never
    );

    const changed = await repo.setActiveRunStatus("conv-1", "running");

    expect(changed).toBe(true);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "conv-1", activeRunStatus: { in: ["idle", "error"] } },
      data: { activeRunStatus: "running", pendingUserAction: null },
    });
  });

  describe("upsertMessage", () => {
    it("resolves parent from the previous message when parent_id is missing", async () => {
      const upsert = vi.fn().mockResolvedValue(undefined);
      const update = vi.fn().mockResolvedValue(undefined);
      const repo = new ConversationRepository(
        makePrisma({
          message: {
            findFirst: vi
              .fn()
              .mockResolvedValueOnce(null) // existing self lookup
              .mockResolvedValueOnce({ id: "assistant-1" }), // previous message
            upsert,
          },
          conversation: { update },
        }) as never
      );

      await repo.upsertMessage("conversation-1", {
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
      // 写入后必须 bump conversation.updatedAt
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "conversation-1" } })
      );
    });

    it("defaults runId to null on create when omitted", async () => {
      const upsert = vi.fn().mockResolvedValue(undefined);
      const repo = new ConversationRepository(
        makePrisma({
          message: {
            findFirst: vi.fn().mockResolvedValue(null),
            upsert,
          },
          conversation: { update: vi.fn().mockResolvedValue(undefined) },
        }) as never
      );

      await repo.upsertMessage("conversation-1", {
        id: "user-1",
        parent_id: null,
        format: "assistant-ui",
        content: { id: "user-1", role: "user", content: "hi" },
      });

      expect(upsert.mock.calls[0][0].create.runId).toBeNull();
      expect(upsert.mock.calls[0][0].create.parentId).toBeNull();
    });
  });
});
