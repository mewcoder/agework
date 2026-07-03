import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "../../../generated/prisma/client.js";
import { WorkerRegistryRepository } from "./worker-registry.repository";

function makePrismaMock() {
  return {
    workerInstance: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
      count: vi.fn(),
    },
    workspaceWorkerBinding: {
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
  workerInstanceMocks: {
    findFirst: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  },
  workspaceWorkerBindingMocks: {
    upsert: ReturnType<typeof vi.fn>;
  }
) {
  const baseMock = makePrismaMock();
  return {
    ...baseMock,
    workerInstance: { ...baseMock.workerInstance, ...workerInstanceMocks },
    workspaceWorkerBinding: {
      ...baseMock.workspaceWorkerBinding,
      ...workspaceWorkerBindingMocks,
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) =>
      fn({
        workerInstance: workerInstanceMocks,
        workspaceWorkerBinding: workspaceWorkerBindingMocks,
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
      prisma.workspaceWorkerBinding.findUnique.mockResolvedValue({
        workspaceId: "ws-1",
        workerInstance: { status: "running" },
      });
      const result = await repository.findActiveByWorkspace("ws-1");
      expect(result).toEqual({
        workspaceId: "ws-1",
        workerInstance: { status: "running" },
      });
    });

    it("returns null when resource status is not running", async () => {
      prisma.workspaceWorkerBinding.findUnique.mockResolvedValue({
        workspaceId: "ws-1",
        workerInstance: { status: "stopped" },
      });
      const result = await repository.findActiveByWorkspace("ws-1");
      expect(result).toBeNull();
    });

    it("returns null when no binding exists", async () => {
      prisma.workspaceWorkerBinding.findUnique.mockResolvedValue(null);
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

    it("creates a new WorkerInstance row when none exists for the owner", async () => {
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
      prisma.workerInstance.updateMany.mockResolvedValue({ count: 1 });
      await repository.markStoppedByOwner("sandbox", "workspace", "ws-1");
      expect(prisma.workerInstance.updateMany).toHaveBeenCalledWith({
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
      prisma.workspaceWorkerBinding.findUnique.mockResolvedValue({
        workerInstance: { runtimeType: "sandbox", runtimeInstanceId: "inst-1" },
      });
      const result = await repository.isRuntimeInstanceBoundToWorkspace(
        "sandbox",
        "ws-1",
        "inst-1"
      );
      expect(result).toBe(true);
    });

    it("returns false when runtimeInstanceId does not match", async () => {
      prisma.workspaceWorkerBinding.findUnique.mockResolvedValue({
        workerInstance: {
          runtimeType: "sandbox",
          runtimeInstanceId: "inst-other",
        },
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
      prisma.workerInstance.findMany.mockResolvedValue([{ id: "1" }]);
      prisma.workerInstance.count.mockResolvedValue(1);
      const result = await repository.listResourcesPage({
        status: "running",
        take: 10,
        skip: 0,
      });
      expect(prisma.workerInstance.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { status: "running" } })
      );
      expect(result).toEqual({ items: [{ id: "1" }], total: 1 });
    });
  });

  describe("insertStarting", () => {
    it("creates a starting row and returns ok:true when no active row exists for the owner", async () => {
      const prismaMocks = makePrismaMock();
      prismaMocks.workerInstance.create.mockResolvedValue({ id: "rr-1" });
      const repository = new WorkerRegistryRepository(prismaMocks as never);

      const result = await repository.insertStarting(
        {
          runtimeType: "sandbox",
          isolationScope: "workspace",
          workspaceId: "ws-1",
          ownerId: "ws-1",
        },
        "placeholder-1",
        "http",
        "token-1"
      );

      expect(result).toEqual({ ok: true });
      expect(prismaMocks.workerInstance.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            runtimeType: "sandbox",
            isolationScope: "workspace",
            ownerId: "ws-1",
            runtimeInstanceId: "placeholder-1",
            transport: "http",
            startToken: "token-1",
            status: "starting",
          }),
        })
      );
    });

    it("returns ok:false with the existing active row when the unique constraint is violated", async () => {
      const prismaMocks = makePrismaMock();
      prismaMocks.workerInstance.create.mockRejectedValue({ code: "P2002" });
      prismaMocks.workerInstance.findFirst.mockResolvedValue({
        runtimeInstanceId: "docker-resource-1",
        status: "running",
      });
      const repository = new WorkerRegistryRepository(prismaMocks as never);

      const result = await repository.insertStarting(
        {
          runtimeType: "sandbox",
          isolationScope: "workspace",
          workspaceId: "ws-1",
          ownerId: "ws-1",
        },
        "placeholder-2",
        "http",
        "token-2"
      );

      expect(result).toEqual({
        ok: false,
        existing: { runtimeInstanceId: "docker-resource-1", status: "running" },
      });
      expect(prismaMocks.workerInstance.findFirst).toHaveBeenCalledWith({
        where: { ownerId: "ws-1", status: { in: ["starting", "running"] } },
      });
    });

    it("rethrows a P2002 error when no active row is found for the owner (unexpected constraint)", async () => {
      const prismaMocks = makePrismaMock();
      const err = { code: "P2002" };
      prismaMocks.workerInstance.create.mockRejectedValue(err);
      prismaMocks.workerInstance.findFirst.mockResolvedValue(null);
      const repository = new WorkerRegistryRepository(prismaMocks as never);

      await expect(
        repository.insertStarting(
          {
            runtimeType: "sandbox",
            isolationScope: "workspace",
            workspaceId: "ws-1",
            ownerId: "ws-1",
          },
          "placeholder-3",
          "http",
          "token-3"
        )
      ).rejects.toBe(err);
    });

    it("rethrows a non-unique-constraint error unchanged", async () => {
      const prismaMocks = makePrismaMock();
      const err = new Error("connection refused");
      prismaMocks.workerInstance.create.mockRejectedValue(err);
      const repository = new WorkerRegistryRepository(prismaMocks as never);

      await expect(
        repository.insertStarting(
          {
            runtimeType: "sandbox",
            isolationScope: "workspace",
            workspaceId: "ws-1",
            ownerId: "ws-1",
          },
          "placeholder-4",
          "http",
          "token-4"
        )
      ).rejects.toBe(err);
      expect(prismaMocks.workerInstance.findFirst).not.toHaveBeenCalled();
    });

    it("deletes stale terminal rows for the owner before creating the starting row", async () => {
      const prismaMocks = makePrismaMock();
      prismaMocks.workerInstance.deleteMany.mockResolvedValue({ count: 1 });
      prismaMocks.workerInstance.create.mockResolvedValue({ id: "rr-2" });
      const repository = new WorkerRegistryRepository(prismaMocks as never);

      const result = await repository.insertStarting(
        {
          runtimeType: "sandbox",
          isolationScope: "workspace",
          workspaceId: "ws-1",
          ownerId: "ws-1",
        },
        "placeholder-5",
        "http",
        "token-5"
      );

      expect(result).toEqual({ ok: true });
      expect(prismaMocks.workerInstance.deleteMany).toHaveBeenCalledWith({
        where: {
          runtimeType: "sandbox",
          isolationScope: "workspace",
          ownerId: "ws-1",
          status: { in: ["stopped", "error"] },
        },
      });
      // deleteMany runs before create — the cleanup must happen first so
      // upsertRunning's later findFirst can't pick a stale row instead of
      // this new starting row.
      expect(
        prismaMocks.workerInstance.deleteMany.mock.invocationCallOrder[0]
      ).toBeLessThan(
        prismaMocks.workerInstance.create.mock.invocationCallOrder[0]
      );
    });
  });

  describe("markAllStartingAsError", () => {
    it("updates every starting row to error, regardless of runtimeType", async () => {
      const prismaMocks = makePrismaMock();
      prismaMocks.workerInstance.updateMany.mockResolvedValue({ count: 2 });
      const repository = new WorkerRegistryRepository(prismaMocks as never);

      await repository.markAllStartingAsError();

      expect(prismaMocks.workerInstance.updateMany).toHaveBeenCalledWith({
        where: { status: "starting" },
        data: expect.objectContaining({ status: "error" }),
      });
    });
  });

  describe("findActiveByOwnerId", () => {
    it("returns the startToken, runtimeType, runtimeInstanceId, isolationScope and ownerId when the owner has a starting row", async () => {
      prisma.workerInstance.findUnique.mockResolvedValue({
        startToken: "token-starting",
        runtimeType: "sandbox",
        runtimeInstanceId: "inst-1",
        isolationScope: "workspace",
        ownerId: "owner-1",
      });

      const result = await repository.findActiveByOwnerId("owner-1");

      expect(prisma.workerInstance.findUnique).toHaveBeenCalledWith({
        where: { activeOwnerKey: "owner-1" },
        select: {
          startToken: true,
          runtimeType: true,
          runtimeInstanceId: true,
          isolationScope: true,
          ownerId: true,
        },
      });
      expect(result).toEqual({
        startToken: "token-starting",
        runtimeType: "sandbox",
        runtimeInstanceId: "inst-1",
        isolationScope: "workspace",
        ownerId: "owner-1",
      });
    });

    it("returns the startToken, runtimeType, runtimeInstanceId, isolationScope and ownerId when the owner has a running row", async () => {
      prisma.workerInstance.findUnique.mockResolvedValue({
        startToken: "token-running",
        runtimeType: "local",
        runtimeInstanceId: "inst-2",
        isolationScope: "workspace",
        ownerId: "owner-2",
      });

      const result = await repository.findActiveByOwnerId("owner-2");

      expect(result).toEqual({
        startToken: "token-running",
        runtimeType: "local",
        runtimeInstanceId: "inst-2",
        isolationScope: "workspace",
        ownerId: "owner-2",
      });
    });

    it("returns null when the owner has no active row", async () => {
      prisma.workerInstance.findUnique.mockResolvedValue(null);

      const result = await repository.findActiveByOwnerId("owner-3");

      expect(result).toBeNull();
    });
  });

  describe("findRunningByRuntimeType", () => {
    it("finds all running rows for the given runtimeType", async () => {
      const prismaMocks = makePrismaMock();
      prismaMocks.workerInstance.findMany.mockResolvedValue([
        {
          id: "rr-1",
          runtimeType: "local",
          isolationScope: "workspace",
          ownerId: "ws-1",
          runtimeInstanceId: "4242:token",
        },
      ]);
      const repository = new WorkerRegistryRepository(prismaMocks as never);

      const result = await repository.findRunningByRuntimeType("local");

      expect(prismaMocks.workerInstance.findMany).toHaveBeenCalledWith({
        where: { runtimeType: "local", status: "running" },
      });
      expect(result).toEqual([
        {
          id: "rr-1",
          runtimeType: "local",
          isolationScope: "workspace",
          ownerId: "ws-1",
          runtimeInstanceId: "4242:token",
        },
      ]);
    });
  });

  describe("findRunningContainerRows", () => {
    it("finds all running docker/opensandbox rows", async () => {
      const prismaMocks = makePrismaMock();
      prismaMocks.workerInstance.findMany.mockResolvedValue([
        {
          id: "rr-1",
          runtimeType: "docker",
          isolationScope: "workspace",
          ownerId: "ws-1",
          runtimeInstanceId: "container-1",
        },
      ]);
      const repository = new WorkerRegistryRepository(prismaMocks as never);

      const result = await repository.findRunningContainerRows();

      expect(prismaMocks.workerInstance.findMany).toHaveBeenCalledWith({
        where: {
          status: "running",
          runtimeType: { in: ["docker", "opensandbox"] },
        },
      });
      expect(result).toEqual([
        {
          id: "rr-1",
          runtimeType: "docker",
          isolationScope: "workspace",
          ownerId: "ws-1",
          runtimeInstanceId: "container-1",
        },
      ]);
    });
  });
});

// activeOwnerKey uniqueness is a real SQLite constraint (see schema.prisma
// WorkerInstance.activeOwnerKey @unique) — mocking prisma calls can't exercise
// it, so this suite runs against a real, disposable SQLite database pushed
// from the current schema.
describe("WorkerRegistryRepository — activeOwnerKey uniqueness (real sqlite)", () => {
  const serverRoot = path.resolve(__dirname, "../../..");
  let tmpDir: string;
  let prisma: InstanceType<typeof PrismaClient>;
  let repository: WorkerRegistryRepository;

  const baseInput = {
    runtimeType: "sandbox",
    isolationScope: "workspace",
    workspaceId: "ws-real-1",
    ownerId: "owner-real-1",
  };

  beforeAll(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "worker-registry-repo-test-"));
    const dbPath = path.join(tmpDir, "test.db");
    execFileSync(
      path.join(serverRoot, "node_modules", ".bin", "prisma"),
      ["db", "push", "--accept-data-loss", "--url", `file:${dbPath}`],
      { cwd: serverRoot, stdio: "pipe" }
    );
    prisma = new PrismaClient({
      adapter: new PrismaBetterSqlite3({ url: `file:${dbPath}` }),
    });
    repository = new WorkerRegistryRepository(prisma as never);
    // upsertRunning creates a WorkspaceWorkerBinding row, which FK-references
    // Workspace -> User; seed the minimum rows those foreign keys need.
    await prisma.user.create({
      data: {
        id: "user-real-1",
        username: "worker-registry-real-test",
        passwordHash: "x",
      },
    });
    await prisma.workspace.create({
      data: {
        id: baseInput.workspaceId,
        name: "worker-registry real test workspace",
        userId: "user-real-1",
      },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    await prisma.workerInstance.deleteMany({});
  });

  it("rejects a concurrent insertStarting for the same owner instead of inserting a duplicate row", async () => {
    const first = await repository.insertStarting(
      baseInput,
      "inst-real-1",
      "http",
      "token-real-1"
    );
    expect(first).toEqual({ ok: true });

    const second = await repository.insertStarting(
      baseInput,
      "inst-real-2",
      "http",
      "token-real-2"
    );
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.existing).toEqual({
        runtimeInstanceId: "inst-real-1",
        status: "starting",
      });
    }

    const rows = await prisma.workerInstance.findMany({
      where: { ownerId: baseInput.ownerId },
    });
    expect(rows).toHaveLength(1);
  });

  it("allows a new insertStarting once the owner's previous row reaches a terminal state", async () => {
    await repository.insertStarting(
      baseInput,
      "inst-real-3",
      "http",
      "token-real-3"
    );
    await repository.markStoppedByOwner(
      baseInput.runtimeType,
      baseInput.isolationScope,
      baseInput.ownerId
    );

    const result = await repository.insertStarting(
      baseInput,
      "inst-real-4",
      "http",
      "token-real-4"
    );

    expect(result).toEqual({ ok: true });
    const rows = await prisma.workerInstance.findMany({
      where: { ownerId: baseInput.ownerId },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("starting");
  });

  it("upsertRunning stores activeOwnerKey equal to ownerId, blocking a concurrent insertStarting", async () => {
    await repository.upsertRunning(baseInput, "inst-real-5", "http");

    const row = await prisma.workerInstance.findFirst({
      where: { ownerId: baseInput.ownerId },
    });
    expect(row?.activeOwnerKey).toBe(baseInput.ownerId);

    const conflict = await repository.insertStarting(
      baseInput,
      "inst-real-6",
      "http",
      "token-real-6"
    );
    expect(conflict.ok).toBe(false);
  });
});
