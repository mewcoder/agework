vi.mock("../prisma/prisma.service", () => ({
  PrismaService: class PrismaService {},
}));

import { RunRepository } from "./run.repository";

describe("RunRepository", () => {
  it("creates a run with the given identifiers", async () => {
    const create = vi.fn().mockResolvedValue({ id: "run-1", status: "queued" });
    const service = new RunRepository({
      run: { create },
    } as never);

    await service.create({
      id: "run-1",
      conversationId: "conversation-1",
      agentType: "claude",
      runtimeType: "native",
    });

    // conversation 存在性守卫已上移到 RunLauncher.claimRun，repository 只写 run 表
    expect(create).toHaveBeenCalledWith({
      data: {
        id: "run-1",
        conversationId: "conversation-1",
        agentType: "claude",
        runtimeType: "native",
      },
    });
  });

  it("marks a run as running with a startedAt timestamp", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const service = new RunRepository({ run: { updateMany } } as never);

    await service.markRunning("run-1");

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: "run-1",
        status: { in: ["queued", "preparing", "running", "requires_action"] },
      },
      data: expect.objectContaining({ status: "running" }),
    });
  });

  it("marks a run as finished", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const service = new RunRepository({ run: { updateMany } } as never);

    await service.markFinished("run-1");

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: "run-1",
        status: {
          in: [
            "queued",
            "preparing",
            "running",
            "cancelling",
            "requires_action",
          ],
        },
      },
      data: expect.objectContaining({ status: "finished" }),
    });
  });

  it("marks a run as errored with the error message", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const service = new RunRepository({ run: { updateMany } } as never);

    await service.markError("run-1", "boom");

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: "run-1",
        status: {
          in: [
            "queued",
            "preparing",
            "running",
            "cancelling",
            "requires_action",
          ],
        },
      },
      data: expect.objectContaining({ status: "error", error: "boom" }),
    });
  });

  it("marks a run as cancelling", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const service = new RunRepository({ run: { updateMany } } as never);

    await service.markCancelling("run-1");

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: "run-1",
        status: {
          in: [
            "queued",
            "preparing",
            "running",
            "cancelling",
            "requires_action",
          ],
        },
      },
      data: { status: "cancelling" },
    });
  });

  it("marks a run as requiring action without overwriting cancelling runs", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const service = new RunRepository({ run: { updateMany } } as never);

    await service.markRequiresAction("run-1");

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: "run-1",
        status: { in: ["queued", "preparing", "running", "requires_action"] },
      },
      data: { status: "requires_action" },
    });
  });

  it("records token usage for a run", async () => {
    const update = vi.fn().mockResolvedValue({});
    const service = new RunRepository({ run: { update } } as never);

    const usage = {
      inputTokens: 100,
      outputTokens: 40,
      cachedInputTokens: 25,
      reasoningOutputTokens: 10,
      cacheCreationInputTokens: 5,
      totalCostUsd: 0.0123,
      numTurns: 2,
      durationApiMs: 22368,
    };
    await service.recordUsage("run-1", usage);

    expect(update).toHaveBeenCalledWith({
      where: { id: "run-1" },
      data: { usage },
    });
  });

  it("queries admin run detail with owner-context join and returns the raw row (响应塑形归 RunService)", async () => {
    const row = {
      id: "run-1",
      conversationId: "conversation-1",
      agentType: "claude",
      runtimeType: "sandbox",
      status: "running",
      conversation: {
        id: "conversation-1",
        title: "Fix login",
        runStatus: "running",
        pendingUserAction: null,
        agentSessionId: "session-1",
        workspaceId: "workspace-1",
        workspace: {
          id: "workspace-1",
          name: "AgeWork",
          userId: "user-1",
          user: { id: "user-1", username: "mew" },
        },
      },
    };
    const findRun = vi.fn().mockResolvedValue(row);
    const service = new RunRepository({
      run: { findUnique: findRun },
    } as never);

    const detail = await service.findAdminDetail("run-1");

    // 携带 owner 上下文的 join(数据访问),不在 repository 摊平/塑形
    expect(findRun).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "run-1" },
        include: expect.objectContaining({ conversation: expect.any(Object) }),
      })
    );
    expect(detail).toBe(row);
  });

  it("finds the most recent active run for a conversation", async () => {
    const findFirst = vi
      .fn()
      .mockResolvedValue({ id: "run-1", status: "running" });
    const service = new RunRepository({ run: { findFirst } } as never);

    const run = await service.findActiveByConversationId("conversation-1");

    expect(findFirst).toHaveBeenCalledWith({
      where: {
        conversationId: "conversation-1",
        status: {
          in: [
            "queued",
            "preparing",
            "running",
            "cancelling",
            "requires_action",
          ],
        },
      },
      orderBy: { createdAt: "desc" },
    });
    expect(run?.id).toBe("run-1");
  });

  it("finds the conversationId for a run", async () => {
    const findUnique = vi
      .fn()
      .mockResolvedValue({ conversationId: "conversation-1" });
    const service = new RunRepository({ run: { findUnique } } as never);

    const conversationId = await service.findConversationId("run-1");

    expect(findUnique).toHaveBeenCalledWith({
      where: { id: "run-1" },
      select: { conversationId: true },
    });
    expect(conversationId).toBe("conversation-1");
  });

  it("returns null when the run does not exist", async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const service = new RunRepository({ run: { findUnique } } as never);

    expect(await service.findConversationId("missing")).toBeNull();
  });

  it("reads Host run rows in one query for restart reconciliation", async () => {
    const rows = [
      { id: "run-1", conversationId: "conversation-1", status: "error" },
    ];
    const findMany = vi.fn().mockResolvedValue(rows);
    const service = new RunRepository({ run: { findMany } } as never);

    await expect(
      service.findRuntimeReconciliationRows(["run-1", "run-missing"])
    ).resolves.toEqual(rows);
    expect(findMany).toHaveBeenCalledWith({
      where: { id: { in: ["run-1", "run-missing"] } },
      select: { id: true, conversationId: true, status: true },
    });
  });

  it("lists active run conversation ids for a workspace (deduped)", async () => {
    const findMany = vi
      .fn()
      .mockResolvedValue([
        { conversationId: "conversation-1" },
        { conversationId: "conversation-2" },
      ]);
    const service = new RunRepository({ run: { findMany } } as never);

    const ids = await service.findActiveConversationIdsForWorkspace("ws-1");

    expect(ids).toEqual(["conversation-1", "conversation-2"]);
    expect(findMany).toHaveBeenCalledWith({
      where: {
        conversation: { workspaceId: "ws-1" },
        status: {
          in: [
            "queued",
            "preparing",
            "running",
            "cancelling",
            "requires_action",
          ],
        },
      },
      select: { conversationId: true },
      distinct: ["conversationId"],
    });
  });
});
