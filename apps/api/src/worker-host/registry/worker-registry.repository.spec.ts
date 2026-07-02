import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkerRegistryRepository } from "./worker-registry.repository";

function makePrismaMock() {
  return {
    runtimeInstance: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      count: vi.fn(),
    },
    workspaceRuntimeInstance: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      deleteMany: vi.fn(),
    },
    workspace: {
      findMany: vi.fn(),
    },
  };
}

function makePrismaWithTransaction(
  runtimeInstanceMocks: {
    findFirst: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  },
  workspaceRuntimeInstanceMocks: {
    upsert: ReturnType<typeof vi.fn>;
  }
) {
  const baseMock = makePrismaMock();
  return {
    ...baseMock,
    runtimeInstance: { ...baseMock.runtimeInstance, ...runtimeInstanceMocks },
    workspaceRuntimeInstance: {
      ...baseMock.workspaceRuntimeInstance,
      ...workspaceRuntimeInstanceMocks,
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) =>
      fn({
        runtimeInstance: runtimeInstanceMocks,
        workspaceRuntimeInstance: workspaceRuntimeInstanceMocks,
      })
    ),
  };
}

describe("WorkerRegistryRepository", () => {
  let prisma: ReturnType<typeof makePrismaMock>;
  let repository: WorkerRegistryRepository;

  beforeEach(() => {
    prisma = makePrismaMock();
    repository = new WorkerRegistryRepository(prisma as any);
  });

  describe("findActiveByWorkspace", () => {
    it("returns the binding when resource status is running", async () => {
      prisma.workspaceRuntimeInstance.findUnique.mockResolvedValue({
        workspaceId: "ws-1",
        resource: { status: "running" },
      });
      const result = await repository.findActiveByWorkspace("ws-1");
      expect(result).toEqual({
        workspaceId: "ws-1",
        resource: { status: "running" },
      });
    });

    it("returns null when resource status is not running", async () => {
      prisma.workspaceRuntimeInstance.findUnique.mockResolvedValue({
        workspaceId: "ws-1",
        resource: { status: "stopped" },
      });
      const result = await repository.findActiveByWorkspace("ws-1");
      expect(result).toBeNull();
    });

    it("returns null when no binding exists", async () => {
      prisma.workspaceRuntimeInstance.findUnique.mockResolvedValue(null);
      const result = await repository.findActiveByWorkspace("ws-1");
      expect(result).toBeNull();
    });
  });

  describe("upsertRunning", () => {
    const upsertInput = {
      runtimeType: "sandbox",
      isolationScope: "workspace",
      workspaceId: "ws-1",
      ownerId: "ws-1",
    };

    it("creates a new RuntimeInstance row when none exists for the owner", async () => {
      const findFirst = vi.fn().mockResolvedValue(null);
      const create = vi.fn().mockResolvedValue({ id: "new-id" });
      const upsert = vi.fn().mockResolvedValue({ id: "binding-id" });
      const prismaMock = makePrismaWithTransaction(
        { findFirst, create, update: vi.fn() },
        { upsert }
      );
      repository = new WorkerRegistryRepository(prismaMock as any);

      const result = await repository.upsertRunning(
        upsertInput,
        "inst-1",
        "http"
      );

      expect(findFirst).toHaveBeenCalledWith({
        where: {
          runtimeType: "sandbox",
          isolationScope: "workspace",
          ownerId: "ws-1",
        },
      });
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            runtimeType: "sandbox",
            isolationScope: "workspace",
            ownerId: "ws-1",
            runtimeInstanceId: "inst-1",
            transport: "http",
            status: "running",
          }),
        })
      );
      expect(result.resource).toEqual({ id: "new-id" });
    });

    it("updates the existing row instead of creating a new one when the owner already has one", async () => {
      const findFirst = vi.fn().mockResolvedValue({
        id: "existing-id",
        metadata: {},
      });
      const create = vi.fn();
      const update = vi.fn().mockResolvedValue({ id: "existing-id" });
      const upsert = vi.fn().mockResolvedValue({ id: "binding-id" });
      const prismaMock = makePrismaWithTransaction(
        { findFirst, create, update },
        { upsert }
      );
      repository = new WorkerRegistryRepository(prismaMock as any);

      await repository.upsertRunning(upsertInput, "inst-2", "http");

      expect(create).not.toHaveBeenCalled();
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "existing-id" } })
      );
    });
  });

  describe("markStoppedByOwner", () => {
    it("updates matching rows to status stopped", async () => {
      prisma.runtimeInstance.updateMany.mockResolvedValue({ count: 1 });
      await repository.markStoppedByOwner("sandbox", "workspace", "ws-1");
      expect(prisma.runtimeInstance.updateMany).toHaveBeenCalledWith({
        where: {
          runtimeType: "sandbox",
          isolationScope: "workspace",
          ownerId: "ws-1",
        },
        data: expect.objectContaining({ status: "stopped" }),
      });
    });
  });

  describe("isRuntimeInstanceBoundToWorkspace", () => {
    it("returns true when runtimeType and runtimeInstanceId both match the binding", async () => {
      prisma.workspaceRuntimeInstance.findUnique.mockResolvedValue({
        resource: { runtimeType: "sandbox", runtimeInstanceId: "inst-1" },
      });
      const result = await repository.isRuntimeInstanceBoundToWorkspace(
        "sandbox",
        "ws-1",
        "inst-1"
      );
      expect(result).toBe(true);
    });

    it("returns false when runtimeInstanceId does not match", async () => {
      prisma.workspaceRuntimeInstance.findUnique.mockResolvedValue({
        resource: { runtimeType: "sandbox", runtimeInstanceId: "inst-other" },
      });
      const result = await repository.isRuntimeInstanceBoundToWorkspace(
        "sandbox",
        "ws-1",
        "inst-1"
      );
      expect(result).toBe(false);
    });
  });

  describe("listResourcesPage", () => {
    it("filters by status when provided and returns items + total", async () => {
      prisma.runtimeInstance.findMany.mockResolvedValue([{ id: "1" }]);
      prisma.runtimeInstance.count.mockResolvedValue(1);
      const result = await repository.listResourcesPage({
        status: "running",
        take: 10,
        skip: 0,
      });
      expect(prisma.runtimeInstance.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { status: "running" } })
      );
      expect(result).toEqual({ items: [{ id: "1" }], total: 1 });
    });
  });
});
