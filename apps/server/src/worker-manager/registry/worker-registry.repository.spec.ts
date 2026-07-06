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
    worker: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
      count: vi.fn(),
    },
    workerWorkspaceBinding: {
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
  workerMocks: {
    findUnique: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  },
  workerWorkspaceBindingMocks: {
    upsert: ReturnType<typeof vi.fn>;
  }
) {
  const baseMock = makePrismaMock();
  return {
    ...baseMock,
    worker: { ...baseMock.worker, ...workerMocks },
    workerWorkspaceBinding: {
      ...baseMock.workerWorkspaceBinding,
      ...workerWorkspaceBindingMocks,
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) =>
      fn({
        worker: workerMocks,
        workerWorkspaceBinding: workerWorkspaceBindingMocks,
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
      prisma.workerWorkspaceBinding.findUnique.mockResolvedValue({
        workspaceId: "ws-1",
        worker: { status: "running" },
      });
      const result = await repository.findActiveByWorkspace("ws-1");
      expect(result).toEqual({
        workspaceId: "ws-1",
        worker: { status: "running" },
      });
    });

    it("returns null when resource status is not running", async () => {
      prisma.workerWorkspaceBinding.findUnique.mockResolvedValue({
        workspaceId: "ws-1",
        worker: { status: "stopped" },
      });
      const result = await repository.findActiveByWorkspace("ws-1");
      expect(result).toBeNull();
    });

    it("returns null when no binding exists", async () => {
      prisma.workerWorkspaceBinding.findUnique.mockResolvedValue(null);
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

    it("creates a new Worker row when none exists for the owner", async () => {
      const findUnique = vi.fn().mockResolvedValue(null);
      const create = vi.fn().mockResolvedValue({ id: "new-id" });
      const upsert = vi.fn().mockResolvedValue({ id: "binding-id" });
      const prismaMock = makePrismaWithTransaction(
        { findUnique, create, update: vi.fn() },
        { upsert }
      );
      repository = new WorkerRegistryRepository(prismaMock as any);

      const result = await repository.upsertRunning(
        upsertInput,
        "inst-1",
        "http",
        "rt-1"
      );

      expect(findUnique).toHaveBeenCalledWith({ where: { ownerId: "ws-1" } });
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            runtimeType: "sandbox",
            isolationScope: "workspace",
            ownerId: "ws-1",
            instanceId: "inst-1",
            transport: "http",
            status: "running",
            runtimeId: "rt-1",
          }),
        })
      );
      expect(result.resource).toEqual({ id: "new-id" });
    });

    it("updates the existing row instead of creating a new one when the owner already has one", async () => {
      const findUnique = vi.fn().mockResolvedValue({
        id: "existing-id",
        metadata: {},
      });
      const create = vi.fn();
      const update = vi.fn().mockResolvedValue({ id: "existing-id" });
      const upsert = vi.fn().mockResolvedValue({ id: "binding-id" });
      const prismaMock = makePrismaWithTransaction(
        { findUnique, create, update },
        { upsert }
      );
      repository = new WorkerRegistryRepository(prismaMock as any);

      await repository.upsertRunning(upsertInput, "inst-2", "http", "rt-1");

      expect(create).not.toHaveBeenCalled();
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "existing-id" } })
      );
    });
  });

  describe("markStoppedByOwner", () => {
    it("physically deletes matching rows", async () => {
      prisma.worker.deleteMany.mockResolvedValue({ count: 1 });
      await repository.markStoppedByOwner("sandbox", "workspace", "ws-1");
      expect(prisma.worker.deleteMany).toHaveBeenCalledWith({
        where: {
          runtimeType: "sandbox",
          isolationScope: "workspace",
          ownerId: "ws-1",
        },
      });
    });
  });

  describe("markErrorByOwner", () => {
    it("physically deletes matching rows", async () => {
      prisma.worker.deleteMany.mockResolvedValue({ count: 1 });
      await repository.markErrorByOwner("sandbox", "workspace", "ws-1");
      expect(prisma.worker.deleteMany).toHaveBeenCalledWith({
        where: {
          runtimeType: "sandbox",
          isolationScope: "workspace",
          ownerId: "ws-1",
        },
      });
    });
  });

  describe("isRuntimeInstanceBoundToWorkspace", () => {
    it("returns true when runtimeType and instanceId both match the binding", async () => {
      prisma.workerWorkspaceBinding.findUnique.mockResolvedValue({
        worker: { runtimeType: "sandbox", instanceId: "inst-1" },
      });
      const result = await repository.isRuntimeInstanceBoundToWorkspace(
        "sandbox",
        "ws-1",
        "inst-1"
      );
      expect(result).toBe(true);
    });

    it("returns false when instanceId does not match", async () => {
      prisma.workerWorkspaceBinding.findUnique.mockResolvedValue({
        worker: {
          runtimeType: "sandbox",
          instanceId: "inst-other",
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
      prisma.worker.findMany.mockResolvedValue([{ id: "1" }]);
      prisma.worker.count.mockResolvedValue(1);
      const result = await repository.listResourcesPage({
        status: "running",
        take: 10,
        skip: 0,
      });
      expect(prisma.worker.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { status: "running" } })
      );
      expect(result).toEqual({ items: [{ id: "1" }], total: 1 });
    });
  });

  describe("insertStarting", () => {
    it("creates a starting row and returns ok:true when no active row exists for the owner", async () => {
      const prismaMocks = makePrismaMock();
      prismaMocks.worker.create.mockResolvedValue({ id: "rr-1" });
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
        "token-1",
        "rt-1"
      );

      expect(result).toEqual({ ok: true });
      expect(prismaMocks.worker.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            runtimeType: "sandbox",
            isolationScope: "workspace",
            ownerId: "ws-1",
            instanceId: "placeholder-1",
            transport: "http",
            startToken: "token-1",
            status: "starting",
            runtimeId: "rt-1",
          }),
        })
      );
    });

    it("returns ok:false with the existing active row when the unique constraint is violated", async () => {
      const prismaMocks = makePrismaMock();
      prismaMocks.worker.create.mockRejectedValue({ code: "P2002" });
      prismaMocks.worker.findUnique.mockResolvedValue({
        instanceId: "docker-resource-1",
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
        "token-2",
        "rt-1"
      );

      expect(result).toEqual({
        ok: false,
        existing: { runtimeInstanceId: "docker-resource-1", status: "running" },
      });
      expect(prismaMocks.worker.findUnique).toHaveBeenCalledWith({
        where: { ownerId: "ws-1" },
      });
    });

    it("rethrows a P2002 error when no active row is found for the owner (unexpected constraint)", async () => {
      const prismaMocks = makePrismaMock();
      const err = { code: "P2002" };
      prismaMocks.worker.create.mockRejectedValue(err);
      prismaMocks.worker.findUnique.mockResolvedValue(null);
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
          "token-3",
          "rt-1"
        )
      ).rejects.toBe(err);
    });

    it("rethrows a non-unique-constraint error unchanged", async () => {
      const prismaMocks = makePrismaMock();
      const err = new Error("connection refused");
      prismaMocks.worker.create.mockRejectedValue(err);
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
          "token-4",
          "rt-1"
        )
      ).rejects.toBe(err);
      expect(prismaMocks.worker.findUnique).not.toHaveBeenCalled();
    });
  });

  describe("markAllStartingAsError", () => {
    it("deletes every starting row, regardless of runtimeType", async () => {
      const prismaMocks = makePrismaMock();
      prismaMocks.worker.deleteMany.mockResolvedValue({ count: 2 });
      const repository = new WorkerRegistryRepository(prismaMocks as never);

      await repository.markAllStartingAsError();

      expect(prismaMocks.worker.deleteMany).toHaveBeenCalledWith({
        where: { status: "starting" },
      });
    });
  });

  describe("findActiveByOwnerId", () => {
    it("returns the startToken, runtimeType, instanceId, isolationScope, ownerId and runtimeId when the owner has an active row", async () => {
      prisma.worker.findUnique.mockResolvedValue({
        startToken: "token-starting",
        runtimeType: "sandbox",
        instanceId: "inst-1",
        isolationScope: "workspace",
        ownerId: "owner-1",
        runtimeId: "rt-1",
      });

      const result = await repository.findActiveByOwnerId("owner-1");

      expect(prisma.worker.findUnique).toHaveBeenCalledWith({
        where: { ownerId: "owner-1" },
        select: {
          startToken: true,
          runtimeType: true,
          instanceId: true,
          isolationScope: true,
          ownerId: true,
          runtimeId: true,
        },
      });
      expect(result).toEqual({
        startToken: "token-starting",
        runtimeType: "sandbox",
        instanceId: "inst-1",
        isolationScope: "workspace",
        ownerId: "owner-1",
        runtimeId: "rt-1",
      });
    });

    it("returns null when the owner has no active row", async () => {
      prisma.worker.findUnique.mockResolvedValue(null);

      const result = await repository.findActiveByOwnerId("owner-3");

      expect(result).toBeNull();
    });
  });

  describe("findRunningByRuntimeType", () => {
    it("finds all running rows for the given runtimeType", async () => {
      const prismaMocks = makePrismaMock();
      prismaMocks.worker.findMany.mockResolvedValue([
        {
          id: "rr-1",
          runtimeType: "local",
          isolationScope: "workspace",
          ownerId: "ws-1",
          instanceId: "4242:token",
        },
      ]);
      const repository = new WorkerRegistryRepository(prismaMocks as never);

      const result = await repository.findRunningByRuntimeType("local");

      expect(prismaMocks.worker.findMany).toHaveBeenCalledWith({
        where: { runtimeType: "local", status: "running" },
      });
      expect(result).toEqual([
        {
          id: "rr-1",
          runtimeType: "local",
          isolationScope: "workspace",
          ownerId: "ws-1",
          instanceId: "4242:token",
        },
      ]);
    });
  });

  describe("findRunningContainerRows", () => {
    it("finds all running docker/opensandbox rows", async () => {
      const prismaMocks = makePrismaMock();
      prismaMocks.worker.findMany.mockResolvedValue([
        {
          id: "rr-1",
          runtimeType: "docker",
          isolationScope: "workspace",
          ownerId: "ws-1",
          instanceId: "container-1",
        },
      ]);
      const repository = new WorkerRegistryRepository(prismaMocks as never);

      const result = await repository.findRunningContainerRows();

      expect(prismaMocks.worker.findMany).toHaveBeenCalledWith({
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
          instanceId: "container-1",
        },
      ]);
    });
  });
});

// ownerId uniqueness is a real SQLite constraint (see schema.prisma
// Worker.ownerId @unique) — mocking prisma calls can't exercise it, so this
// suite runs against a real, disposable SQLite database pushed from the
// current schema.
describe("WorkerRegistryRepository — ownerId uniqueness (real sqlite)", () => {
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
  const targetRuntimeId = "builtin-docker";

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
    // upsertRunning/insertStarting create a WorkerWorkspaceBinding row, which
    // FK-references Workspace -> User, and a Worker row which FK-references
    // Runtime; seed the minimum rows those foreign keys need.
    await prisma.user.create({
      data: {
        id: "user-real-1",
        username: "worker-registry-real-test",
        passwordHash: "x",
      },
    });
    await prisma.runtime.create({
      data: {
        id: targetRuntimeId,
        name: targetRuntimeId,
        source: "builtin",
        runtimeType: "docker",
      },
    });
    await prisma.workspace.create({
      data: {
        id: baseInput.workspaceId,
        name: "worker-registry real test workspace",
        userId: "user-real-1",
        isolationScope: "workspace",
        runtimeId: targetRuntimeId,
      },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    await prisma.worker.deleteMany({});
  });

  it("rejects a concurrent insertStarting for the same owner instead of inserting a duplicate row", async () => {
    const first = await repository.insertStarting(
      baseInput,
      "inst-real-1",
      "http",
      "token-real-1",
      targetRuntimeId
    );
    expect(first).toEqual({ ok: true });

    const second = await repository.insertStarting(
      baseInput,
      "inst-real-2",
      "http",
      "token-real-2",
      targetRuntimeId
    );
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.existing).toEqual({
        runtimeInstanceId: "inst-real-1",
        status: "starting",
      });
    }

    const rows = await prisma.worker.findMany({
      where: { ownerId: baseInput.ownerId },
    });
    expect(rows).toHaveLength(1);
  });

  it("allows a new insertStarting once the owner's previous row is physically removed on stop", async () => {
    await repository.insertStarting(
      baseInput,
      "inst-real-3",
      "http",
      "token-real-3",
      targetRuntimeId
    );
    await repository.markStoppedByOwner(
      baseInput.runtimeType,
      baseInput.isolationScope,
      baseInput.ownerId
    );

    const afterStop = await prisma.worker.findMany({
      where: { ownerId: baseInput.ownerId },
    });
    expect(afterStop).toHaveLength(0);

    const result = await repository.insertStarting(
      baseInput,
      "inst-real-4",
      "http",
      "token-real-4",
      targetRuntimeId
    );

    expect(result).toEqual({ ok: true });
    const rows = await prisma.worker.findMany({
      where: { ownerId: baseInput.ownerId },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("starting");
  });

  it("upsertRunning stores ownerId uniquely, blocking a concurrent insertStarting", async () => {
    await repository.upsertRunning(
      baseInput,
      "inst-real-5",
      "http",
      targetRuntimeId
    );

    const row = await prisma.worker.findFirst({
      where: { ownerId: baseInput.ownerId },
    });
    expect(row?.ownerId).toBe(baseInput.ownerId);

    const conflict = await repository.insertStarting(
      baseInput,
      "inst-real-6",
      "http",
      "token-real-6",
      targetRuntimeId
    );
    expect(conflict.ok).toBe(false);
  });
});
