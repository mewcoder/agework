vi.mock("@agework/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@agework/shared")>()),
  generateId: () => "dir260614113047",
}));

import { WorkspaceRepository } from "./workspace.repository";

beforeEach(() => {
  vi.clearAllMocks();
});

// $transaction 支持 create/update 使用的回调式事务。
function makePrisma(parts: {
  workspace?: Record<string, unknown>;
  workspaceDirectory?: Record<string, unknown>;
  run?: Record<string, unknown>;
  user?: Record<string, unknown>;
}) {
  const client = {
    workspace: parts.workspace ?? {},
    workspaceDirectory: parts.workspaceDirectory ?? {},
    run: parts.run ?? {},
    user: parts.user ?? {},
    $transaction: vi.fn((arg: unknown) =>
      typeof arg === "function"
        ? (arg as (tx: unknown) => unknown)(client)
        : Promise.resolve(arg)
    ),
  };
  return client;
}

describe("WorkspaceRepository", () => {
  it("createWithDirectory persists workspace fields and a managed directory atomically", async () => {
    const workspaceCreate = vi.fn((args: { data: Record<string, unknown> }) =>
      Promise.resolve({ id: args.data.id })
    );
    const directoryCreate = vi.fn((args: { data: Record<string, unknown> }) =>
      Promise.resolve({ ...args.data })
    );
    const findUniqueOrThrow = vi.fn().mockResolvedValue({
      id: "ws-1",
      name: "Local workspace",
      userId: "admin-1",
      scope: "workspace",
      runtimeHostId: "builtin",
      runtime: { runtimeType: "native" },
      directory: { source: "managed" },
    });
    const prisma = makePrisma({
      workspace: {
        create: workspaceCreate,
        findUniqueOrThrow,
      },
      workspaceDirectory: { create: directoryCreate },
    });
    const repo = new WorkspaceRepository(prisma as never);

    const row = await repo.createWithDirectory({
      id: "ws-1",
      name: "Local workspace",
      gitUrl: undefined,
      description: null,
      userId: "admin-1",
      scope: "workspace",
      runtimeType: "native",
      rootPath: "/tmp/ws-1",
      directorySource: "managed",
      runtimeHostId: "builtin",
    });

    expect(workspaceCreate.mock.calls[0]?.[0].data).toMatchObject({
      id: "ws-1",
      name: "Local workspace",
      userId: "admin-1",
      scope: "workspace",
      runtimeType: "native",
      runtimeHostId: "builtin",
    });
    expect(directoryCreate).toHaveBeenCalledWith({
      data: {
        id: "dir260614113047",
        workspaceId: "ws-1",
        rootPath: "/tmp/ws-1",
        status: "ready",
        source: "managed",
        metadata: {},
      },
    });
    expect(prisma.$transaction).toHaveBeenCalled();
    expect((row as { directory: { source: string } }).directory.source).toBe(
      "managed"
    );
  });

  it("updateOwned scopes the lookup to the owner and returns null when not found", async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const update = vi.fn();
    const prisma = makePrisma({ workspace: { findFirst, update } });
    const repo = new WorkspaceRepository(prisma as never);

    const result = await repo.updateOwned("intruder", "ws-x", {
      name: "New name",
    });

    expect(result).toBeNull();
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: "ws-x", userId: "intruder", deletedAt: null },
    });
    expect(update).not.toHaveBeenCalled();
  });

  it("updateById ignores ownership but still requires the workspace to exist", async () => {
    const findFirst = vi.fn().mockResolvedValue({ id: "ws-x" });
    const update = vi
      .fn()
      .mockResolvedValue({ id: "ws-x", directory: { rootPath: "/tmp" } });
    const prisma = makePrisma({ workspace: { findFirst, update } });
    const repo = new WorkspaceRepository(prisma as never);

    await repo.updateById("ws-x", { name: "New name" });

    expect(findFirst).toHaveBeenCalledWith({
      where: { id: "ws-x", deletedAt: null },
    });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "ws-x" },
        data: { name: "New name", description: undefined },
      })
    );
  });

  it("getOwnedId only matches the caller's non-deleted workspace", async () => {
    const findFirst = vi.fn().mockResolvedValue({ id: "ws-1" });
    const prisma = makePrisma({ workspace: { findFirst } });
    const repo = new WorkspaceRepository(prisma as never);

    await repo.getOwnedId("user-1", "ws-1");

    expect(findFirst).toHaveBeenCalledWith({
      where: { id: "ws-1", userId: "user-1", deletedAt: null },
      select: { id: true, runtimeHostId: true },
    });
  });

  it("softDelete only soft-deletes the workspace boundary", async () => {
    const update = vi.fn().mockResolvedValue({ id: "ws-1" });
    const prisma = makePrisma({
      workspace: { update },
    });
    const repo = new WorkspaceRepository(prisma as never);
    const deletedAt = new Date("2026-06-29T10:00:00.000Z");

    await repo.softDelete("ws-1", deletedAt);

    expect(update).toHaveBeenCalledWith({
      where: { id: "ws-1" },
      data: { deletedAt },
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
