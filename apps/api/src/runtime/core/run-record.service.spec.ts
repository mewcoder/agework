vi.mock("../prisma/prisma.service", () => ({
  PrismaService: class PrismaService {},
}));

import { RunRecordService } from "./run-record.service";

describe("RunRecordService", () => {
  it("creates a run with the given identifiers", async () => {
    const findFirst = vi.fn().mockResolvedValue({ id: "conversation-1" });
    const create = vi.fn().mockResolvedValue({ id: "run-1", status: "queued" });
    const service = new RunRecordService({
      conversation: { findFirst },
      run: { create },
    } as never);

    await service.create({
      id: "run-1",
      conversationId: "conversation-1",
      agentType: "claude",
      runtimeType: "local",
    });

    expect(findFirst).toHaveBeenCalledWith({
      where: {
        id: "conversation-1",
        deletedAt: null,
        workspace: { deletedAt: null },
      },
      select: { id: true },
    });
    expect(create).toHaveBeenCalledWith({
      data: {
        id: "run-1",
        conversationId: "conversation-1",
        agentType: "claude",
        runtimeType: "local",
      },
    });
  });

  it("rejects run creation when conversation does not exist", async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const create = vi.fn();
    const service = new RunRecordService({
      conversation: { findFirst },
      run: { create },
    } as never);

    await expect(
      service.create({
        id: "run-1",
        conversationId: "conversation-1",
        agentType: "claude",
        runtimeType: "local",
      })
    ).rejects.toThrow("Conversation 不存在");

    expect(create).not.toHaveBeenCalled();
  });

  it("marks a run as running with a startedAt timestamp", async () => {
    const update = vi.fn().mockResolvedValue({});
    const service = new RunRecordService({ run: { update } } as never);

    await service.markRunning("run-1");

    expect(update).toHaveBeenCalledWith({
      where: { id: "run-1" },
      data: expect.objectContaining({ status: "running" }),
    });
  });

  it("marks a run as finished", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const service = new RunRecordService({ run: { updateMany } } as never);

    await service.markFinished("run-1");

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "run-1", status: { in: ["queued", "preparing", "running", "cancelling", "requires_action"] } },
      data: expect.objectContaining({ status: "finished" }),
    });
  });

  it("marks a run as errored with the error message", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const service = new RunRecordService({ run: { updateMany } } as never);

    await service.markError("run-1", "boom");

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "run-1", status: { in: ["queued", "preparing", "running", "cancelling", "requires_action"] } },
      data: expect.objectContaining({ status: "error", error: "boom" }),
    });
  });

  it("marks a run as cancelling", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const service = new RunRecordService({ run: { updateMany } } as never);

    await service.markCancelling("run-1");

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "run-1", status: { in: ["queued", "preparing", "running", "cancelling", "requires_action"] } },
      data: { status: "cancelling" },
    });
  });

  it("persists the runtime handle (runtimeType + runtimeResourceId) for a run", async () => {
    const update = vi.fn().mockResolvedValue({});
    const service = new RunRecordService({ run: { update } } as never);

    await service.updateRuntimeHandle("run-1", "docker", "container-abc");

    expect(update).toHaveBeenCalledWith({
      where: { id: "run-1" },
      data: { runtimeType: "docker", runtimeResourceId: "container-abc" },
    });
  });

  it("records token usage for a run", async () => {
    const update = vi.fn().mockResolvedValue({});
    const service = new RunRecordService({ run: { update } } as never);

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

  it("returns admin run detail with owner and runtime resource context", async () => {
    const now = new Date("2026-06-17T00:00:00.000Z");
    const findRun = vi.fn().mockResolvedValue({
      id: "run-1",
      conversationId: "conversation-1",
      agentType: "claude",
      runtimeType: "sandbox",
      runtimeResourceId: "container-abc",
      status: "running",
      phase: null,
      lastSeq: 2,
      lastHeartbeatAt: now,
      error: null,
      startedAt: now,
      finishedAt: null,
      createdAt: now,
      updatedAt: now,
      conversation: {
        id: "conversation-1",
        title: "Fix login",
        activeRunStatus: "running",
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
    });
    const findRuntimeResource = vi.fn().mockResolvedValue({
      id: "resource-1",
      runtimeType: "sandbox",
      isolationScope: "workspace",
      ownerUserId: "user-1",
      ownerWorkspaceId: "workspace-1",
      runtimeResourceId: "container-abc",
      status: "running",
      expiresAt: null,
      createdAt: now,
      updatedAt: now,
      workspaceRuntimes: [
        {
          id: "binding-1",
          workspaceId: "workspace-1",
          createdAt: now,
          updatedAt: now,
        },
      ],
    });
    const service = new RunRecordService({
      run: { findUnique: findRun },
      runtimeResource: { findUnique: findRuntimeResource },
    } as never);

    const detail = await service.detailAdmin("run-1");

    expect(findRun).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "run-1" } })
    );
    expect(findRuntimeResource).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          runtimeType_runtimeResourceId: {
            runtimeType: "sandbox",
            runtimeResourceId: "container-abc",
          },
        },
      })
    );
    expect(detail).toMatchObject({
      id: "run-1",
      userId: "user-1",
      workspaceId: "workspace-1",
      username: "mew",
      conversationTitle: "Fix login",
      workspaceName: "AgeWork",
      conversation: {
        id: "conversation-1",
        activeRunStatus: "running",
        agentSessionId: "session-1",
      },
      workspace: { id: "workspace-1", name: "AgeWork" },
      user: { id: "user-1", username: "mew" },
      runtimeResource: {
        id: "resource-1",
        isolationScope: "workspace",
        status: "running",
      },
    });
    // 详情不再内嵌事件列表，事件改由 listAdminEvents 独立分页提供
    expect(detail).not.toHaveProperty("events");
  });

  it("lists run events with pagination and filters", async () => {
    const now = new Date().toISOString();
    const findMany = vi.fn().mockResolvedValue([
      {
        id: "event-1",
        runId: "run-1",
        seq: 1,
        source: "runtime",
        eventType: "run.status.running",
        level: "info",
        summary: null,
        payload: null,
        payloadRef: null,
        createdAt: now,
      },
    ]);
    const count = vi.fn().mockResolvedValue(1);
    const service = new RunRecordService({
      runEvent: { findMany, count },
    } as never);

    const result = await service.listAdminEvents({
      runId: "run-1",
      source: ["runtime"],
      eventType: "run.status",
      take: 20,
      skip: 0,
    });

    const expectedWhere = {
      runId: "run-1",
      source: { in: ["runtime"] },
      eventType: { contains: "run.status" },
    };
    expect(findMany).toHaveBeenCalledWith({
      where: expectedWhere,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 20,
      skip: 0,
    });
    expect(count).toHaveBeenCalledWith({ where: expectedWhere });
    expect(result).toMatchObject({
      total: 1,
      pageNo: 1,
      pageSize: 20,
      list: [{ id: "event-1", eventType: "run.status.running" }],
    });
  });

  it("finds the most recent active run for a conversation", async () => {
    const findFirst = vi.fn().mockResolvedValue({ id: "run-1", status: "running" });
    const service = new RunRecordService({ run: { findFirst } } as never);

    const run = await service.findActiveByConversationId("conversation-1");

    expect(findFirst).toHaveBeenCalledWith({
      where: {
        conversationId: "conversation-1",
        status: { in: ["queued", "preparing", "running", "cancelling", "requires_action"] },
      },
      orderBy: { createdAt: "desc" },
    });
    expect(run?.id).toBe("run-1");
  });
});
