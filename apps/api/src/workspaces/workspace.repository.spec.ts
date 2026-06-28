vi.mock("@agework/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@agework/shared")>()),
  generateId: () => "dir260614113047",
}));

import { WorkspaceRepository } from "./workspace.repository";

beforeEach(() => {
  vi.clearAllMocks();
});

// $transaction 支持两种形态：回调式（create/update）与数组式（softDelete）。
function makePrisma(parts: {
  workspace?: Record<string, unknown>;
  workspaceDirectory?: Record<string, unknown>;
  run?: Record<string, unknown>;
  conversation?: Record<string, unknown>;
  user?: Record<string, unknown>;
}) {
  const client = {
    workspace: parts.workspace ?? {},
    workspaceDirectory: parts.workspaceDirectory ?? {},
    run: parts.run ?? {},
    conversation: parts.conversation ?? {},
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
      Promise.resolve({ ...args.data })
    );
    const directoryCreate = vi.fn((args: { data: Record<string, unknown> }) =>
      Promise.resolve({ ...args.data })
    );
    const prisma = makePrisma({
      workspace: { create: workspaceCreate },
      workspaceDirectory: { create: directoryCreate },
    });
    const repo = new WorkspaceRepository(prisma as never);

    const row = await repo.createWithDirectory({
      id: "ws-1",
      name: "Local workspace",
      gitUrl: undefined,
      description: null,
      userId: "admin-1",
      runtimeType: "local",
      isolationScope: null,
      sandboxEngine: null,
      rootPath: "/tmp/ws-1",
      directorySource: "managed",
    });

    expect(workspaceCreate.mock.calls[0]?.[0].data).toMatchObject({
      id: "ws-1",
      name: "Local workspace",
      userId: "admin-1",
      runtimeType: "local",
      isolationScope: null,
      sandboxEngine: null,
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

  it("findOwnedId only matches the caller's non-deleted workspace", async () => {
    const findFirst = vi.fn().mockResolvedValue({ id: "ws-1" });
    const prisma = makePrisma({ workspace: { findFirst } });
    const repo = new WorkspaceRepository(prisma as never);

    await repo.findOwnedId("user-1", "ws-1");

    expect(findFirst).toHaveBeenCalledWith({
      where: { id: "ws-1", userId: "user-1", deletedAt: null },
      select: { id: true },
    });
  });

  it("hasActiveRun checks runs in the workspace's conversations", async () => {
    const findFirst = vi.fn().mockResolvedValue({ id: "run-1" });
    const prisma = makePrisma({ run: { findFirst } });
    const repo = new WorkspaceRepository(prisma as never);

    const active = await repo.hasActiveRun("ws-1");

    expect(active).toBe(true);
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          conversation: { workspaceId: "ws-1" },
          status: { in: expect.arrayContaining(["running"]) },
        }),
      })
    );
  });

  it("softDeleteCascade soft-deletes the workspace and its conversations", async () => {
    const update = vi.fn().mockReturnValue("ws-update");
    const updateMany = vi.fn().mockReturnValue("conv-update");
    const prisma = makePrisma({
      workspace: { update },
      conversation: { updateMany },
    });
    const repo = new WorkspaceRepository(prisma as never);

    await repo.softDeleteCascade("ws-1");

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "ws-1" } })
    );
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId: "ws-1", deletedAt: null },
      })
    );
    expect(prisma.$transaction).toHaveBeenCalledWith([
      "ws-update",
      "conv-update",
    ]);
  });
});
