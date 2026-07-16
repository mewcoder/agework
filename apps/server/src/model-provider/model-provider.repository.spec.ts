import { ModelProviderRepository } from "./model-provider.repository";

function makeRepo(modelProvider: Record<string, unknown>) {
  const prisma = { modelProvider };
  return new ModelProviderRepository(prisma as never);
}

describe("ModelProviderRepository", () => {
  it("findManyByApiFormats excludes disabled by default and orders by createdAt asc", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const repo = makeRepo({ findMany });

    await repo.findManyByApiFormats(["anthropic"], false);

    expect(findMany).toHaveBeenCalledWith({
      where: { apiFormat: { in: ["anthropic"] }, isEnabled: true },
      orderBy: { createdAt: "asc" },
    });
  });

  it("findManyByApiFormats includes disabled when requested", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const repo = makeRepo({ findMany });

    await repo.findManyByApiFormats(
      ["openai-responses", "openai-compatible"],
      true
    );

    expect(findMany).toHaveBeenCalledWith({
      where: { apiFormat: { in: ["openai-responses", "openai-compatible"] } },
      orderBy: { createdAt: "asc" },
    });
  });

  it("findEnabled scopes to id + enabled", async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const repo = makeRepo({ findFirst });

    await repo.findEnabled("mp-1");

    expect(findFirst).toHaveBeenCalledWith({
      where: { id: "mp-1", isEnabled: true },
    });
  });

  it("findIdByName excludes the given id and only selects id", async () => {
    const findFirst = vi.fn().mockResolvedValue({ id: "other" });
    const repo = makeRepo({ findFirst });

    await repo.findIdByName({
      scope: "global",
      userId: null,
      name: "dup",
      excludeId: "mp-1",
    });

    expect(findFirst).toHaveBeenCalledWith({
      where: {
        scope: "global",
        userId: null,
        name: "dup",
        id: { not: "mp-1" },
      },
      select: { id: true },
    });
  });
});
