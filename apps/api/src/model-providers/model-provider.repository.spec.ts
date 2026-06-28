import { ModelProviderRepository } from "./model-provider.repository";

function makeRepo(modelProvider: Record<string, unknown>) {
  const prisma = { modelProvider };
  return new ModelProviderRepository(prisma as never);
}

describe("ModelProviderRepository", () => {
  it("findManyByAgent excludes disabled by default and orders by createdAt asc", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const repo = makeRepo({ findMany });

    await repo.findManyByAgent("claude", false);

    expect(findMany).toHaveBeenCalledWith({
      where: { agentType: "claude", isEnabled: true },
      orderBy: { createdAt: "asc" },
    });
  });

  it("findManyByAgent includes disabled when requested", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const repo = makeRepo({ findMany });

    await repo.findManyByAgent("claude", true);

    expect(findMany).toHaveBeenCalledWith({
      where: { agentType: "claude" },
      orderBy: { createdAt: "asc" },
    });
  });

  it("findEnabled scopes to id + agentType + enabled", async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const repo = makeRepo({ findFirst });

    await repo.findEnabled("mp-1", "claude");

    expect(findFirst).toHaveBeenCalledWith({
      where: { id: "mp-1", agentType: "claude", isEnabled: true },
    });
  });

  it("findIdByName excludes the given id and only selects id", async () => {
    const findFirst = vi.fn().mockResolvedValue({ id: "other" });
    const repo = makeRepo({ findFirst });

    await repo.findIdByName({
      agentType: "claude",
      scope: "global",
      userId: null,
      name: "dup",
      excludeId: "mp-1",
    });

    expect(findFirst).toHaveBeenCalledWith({
      where: {
        agentType: "claude",
        scope: "global",
        userId: null,
        name: "dup",
        id: { not: "mp-1" },
      },
      select: { id: true },
    });
  });
});
