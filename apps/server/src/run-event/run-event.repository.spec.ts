import { describe, expect, it, vi } from "vitest";

vi.mock("../prisma/prisma.service", () => ({
  PrismaService: class PrismaService {},
}));

import { RunEventRepository } from "./run-event.repository";

describe("RunEventRepository.listAdminEvents", () => {
  it("lists run events with pagination and filters", async () => {
    const now = new Date().toISOString();
    const findMany = vi.fn().mockResolvedValue([
      {
        id: "event-1",
        runId: "run-1",
        runSeq: 1,
        eventKey: null,
        type: "run.status_changed",
        origin: "worker",
        targetType: "run",
        targetId: "run-1",
        chainId: null,
        refs: null,
        summary: null,
        data: { status: "running" },
        createdAt: now,
      },
    ]);
    const count = vi.fn().mockResolvedValue(1);
    const repo = new RunEventRepository({
      runEvent: { findMany, count },
    } as never);

    const result = await repo.listAdminEvents({
      runId: "run-1",
      origin: ["worker"],
      typePrefix: "run.status",
      take: 20,
      skip: 0,
    });

    const expectedWhere = {
      runId: "run-1",
      origin: { in: ["worker"] },
      type: { startsWith: "run.status" },
    };
    expect(findMany).toHaveBeenCalledWith({
      where: expectedWhere,
      orderBy: [{ runSeq: "asc" }, { id: "asc" }],
      take: 20,
      skip: 0,
    });
    expect(count).toHaveBeenCalledWith({ where: expectedWhere });
    // 数据层只回 list/total,分页信封由 RunEventService 收口。
    expect(result).toMatchObject({
      total: 1,
      list: [{ id: "event-1", type: "run.status_changed" }],
    });
    expect(result).not.toHaveProperty("pageNo");
    expect(result).not.toHaveProperty("pageSize");
  });
});
