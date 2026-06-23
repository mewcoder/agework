vi.mock("../../prisma/prisma.service", () => ({
  PrismaService: class PrismaService {},
}));

import type { RuntimePlacement } from "@agework/shared/protocol";
import { WorkspaceRuntimeRepository } from "./workspace-runtime.repository";

function placement(overrides: Partial<RuntimePlacement> = {}): RuntimePlacement {
  return {
    runtimeType: "sandbox",
    isolationScope: "user",
    userId: "u1",
    workspaceId: "w1",
    hostPath: "/host",
    runtimePath: "/workspaces/w1",
    mountTarget: "/workspaces",
    ...overrides,
  };
}

describe("WorkspaceRuntimeRepository", () => {
  it("finds a running workspace runtime by workspaceId", async () => {
    const findUnique = vi.fn().mockResolvedValue({
      id: "wr-1",
      resource: { id: "rr-1", status: "running" },
    });
    const service = new WorkspaceRuntimeRepository({
      workspaceRuntime: { findUnique },
    } as never);

    const result = await service.findActiveByWorkspace("w1");

    expect(findUnique).toHaveBeenCalledWith({
      where: { workspaceId: "w1" },
      include: { resource: true },
    });
    expect(result?.id).toBe("wr-1");
  });

  it("returns null when the bound resource is not running", async () => {
    const findUnique = vi.fn().mockResolvedValue({
      id: "wr-1",
      resource: { id: "rr-1", status: "stopped" },
    });
    const service = new WorkspaceRuntimeRepository({
      workspaceRuntime: { findUnique },
    } as never);

    expect(await service.findActiveByWorkspace("w1")).toBeNull();
  });

  it("creates a user-isolated runtime resource and binds the workspace to it", async () => {
    const resource = { id: "rr-1", status: "running" };
    const findFirst = vi.fn().mockResolvedValue(null);
    const create = vi.fn().mockResolvedValue(resource);
    const upsert = vi.fn().mockResolvedValue({ id: "wr-1" });
    const transaction = vi.fn(async (cb) =>
      cb({
        runtimeResource: { findFirst, create },
        workspaceRuntime: { upsert },
      })
    );
    const service = new WorkspaceRuntimeRepository({
      $transaction: transaction,
    } as never);

    const result = await service.upsertRunning(
      placement(),
      "container-abc",
      { foo: "bar" }
    );

    expect(findFirst).toHaveBeenCalledWith({
      where: {
        runtimeType: "sandbox",
        isolationScope: "user",
        ownerUserId: "u1",
        ownerWorkspaceId: null,
      },
    });
    expect(create).toHaveBeenCalledWith({
      data: {
        runtimeType: "sandbox",
        isolationScope: "user",
        ownerUserId: "u1",
        ownerWorkspaceId: null,
        runtimeResourceId: "container-abc",
        status: "running",
        expiresAt: null,
        metadata: { foo: "bar" },
      },
    });
    expect(upsert).toHaveBeenCalledWith({
      where: { workspaceId: "w1" },
      create: { workspaceId: "w1", resourceId: "rr-1" },
      update: { resourceId: "rr-1" },
    });
    expect(result.resource).toBe(resource);
  });

  it("updates an existing workspace-isolated resource", async () => {
    const existing = { id: "rr-1" };
    const resource = { id: "rr-1", runtimeResourceId: "container-next" };
    const findFirst = vi.fn().mockResolvedValue(existing);
    const update = vi.fn().mockResolvedValue(resource);
    const upsert = vi.fn().mockResolvedValue({ id: "wr-1" });
    const transaction = vi.fn(async (cb) =>
      cb({
        runtimeResource: { findFirst, update },
        workspaceRuntime: { upsert },
      })
    );
    const service = new WorkspaceRuntimeRepository({
      $transaction: transaction,
    } as never);

    await service.upsertRunning(
      placement({
        isolationScope: "workspace",
        runtimePath: "/workspace",
        mountTarget: "/workspace",
      }),
      "container-next"
    );

    expect(findFirst).toHaveBeenCalledWith({
      where: {
        runtimeType: "sandbox",
        isolationScope: "workspace",
        ownerUserId: "u1",
        ownerWorkspaceId: "w1",
      },
    });
    expect(update).toHaveBeenCalledWith({
      where: { id: "rr-1" },
      data: {
        runtimeResourceId: "container-next",
        status: "running",
        expiresAt: null,
        metadata: {},
      },
    });
  });

  it("marks a resource stopped from a placement", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const service = new WorkspaceRuntimeRepository({
      runtimeResource: { updateMany },
    } as never);

    await service.markStopped(placement());

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        runtimeType: "sandbox",
        isolationScope: "user",
        ownerUserId: "u1",
        ownerWorkspaceId: null,
      },
      data: { status: "stopped" },
    });
  });

  it("marks a user runtime resource stopped by resource key", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const service = new WorkspaceRuntimeRepository({
      runtimeResource: { updateMany },
    } as never);

    await service.markStoppedByResourceKey("sandbox", "user", "u1");

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        runtimeType: "sandbox",
        isolationScope: "user",
        ownerUserId: "u1",
        ownerWorkspaceId: null,
      },
      data: { status: "stopped" },
    });
  });

  it("finds active resources by provider runtime id", async () => {
    const findUnique = vi.fn().mockResolvedValue({ id: "rr-1", status: "running" });
    const service = new WorkspaceRuntimeRepository({
      runtimeResource: { findUnique },
    } as never);

    const result = await service.findActiveResourceByRuntimeId(
      "sandbox",
      "container-abc"
    );

    expect(findUnique).toHaveBeenCalledWith({
      where: {
        runtimeType_runtimeResourceId: {
          runtimeType: "sandbox",
          runtimeResourceId: "container-abc",
        },
      },
    });
    expect(result?.id).toBe("rr-1");
  });

  it("checks whether a runtime resource is bound to the current workspace", async () => {
    const findUnique = vi.fn().mockResolvedValue({
      id: "wr-1",
      resource: {
        runtimeType: "sandbox",
        runtimeResourceId: "container-abc",
      },
    });
    const service = new WorkspaceRuntimeRepository({
      workspaceRuntime: { findUnique },
    } as never);

    await expect(
      service.isRuntimeResourceBoundToWorkspace(
        "sandbox",
        "w1",
        "container-abc"
      )
    ).resolves.toBe(true);
    await expect(
      service.isRuntimeResourceBoundToWorkspace(
        "sandbox",
        "w1",
        "container-other"
      )
    ).resolves.toBe(false);

    expect(findUnique).toHaveBeenCalledWith({
      where: { workspaceId: "w1" },
      include: { resource: true },
    });
  });

  it("deletes workspace bindings and stale resources", async () => {
    const deleteManyWorkspaceRuntime = vi.fn().mockResolvedValue({ count: 1 });
    const deleteManyRuntimeResource = vi.fn().mockResolvedValue({ count: 2 });
    const service = new WorkspaceRuntimeRepository({
      workspaceRuntime: { deleteMany: deleteManyWorkspaceRuntime },
      runtimeResource: { deleteMany: deleteManyRuntimeResource },
    } as never);

    await service.deleteWorkspaceBinding("w1");
    const result = await service.deleteStaleResources();

    expect(deleteManyWorkspaceRuntime).toHaveBeenCalledWith({
      where: { workspaceId: "w1" },
    });
    expect(deleteManyRuntimeResource).toHaveBeenCalledWith({
      where: { status: "stale" },
    });
    expect(result.count).toBe(2);
  });
});
