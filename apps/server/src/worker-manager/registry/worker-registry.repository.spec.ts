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

    it("updates the Worker row by workerId and upserts the workspace binding", async () => {
      const update = vi.fn().mockResolvedValue({ id: "worker-1" });
      const upsert = vi.fn().mockResolvedValue({ id: "binding-id" });
      const prismaMock = makePrismaWithTransaction(
        { findUnique: vi.fn(), create: vi.fn(), update },
        { upsert }
      );
      repository = new WorkerRegistryRepository(prismaMock as any);

      const result = await repository.upsertRunning(
        upsertInput,
        "worker-1",
        "inst-1",
        "http",
        "rt-1"
      );

      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "worker-1" },
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
      expect(upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { workspaceId: "ws-1" },
        })
      );
      expect(result.resource).toEqual({ id: "worker-1" });
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
    it("creates a starting row and returns ok:true with workerId when no active row exists for the owner", async () => {
      const prismaMocks = makePrismaMock();
      prismaMocks.worker.create.mockResolvedValue({ id: "worker-1" });
      const repository = new WorkerRegistryRepository(prismaMocks as never);

      const result = await repository.insertStarting(
        {
          runtimeType: "sandbox",
          isolationScope: "workspace",
          workspaceId: "ws-1",
          ownerId: "ws-1",
        },
        "worker-1",
        "placeholder-1",
        "http",
        "token-1",
        "rt-1"
      );

      expect(result).toEqual({ ok: true, workerId: "worker-1" });
      expect(prismaMocks.worker.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            id: "worker-1",
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
        id: "existing-worker-id",
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
        "worker-2",
        "placeholder-2",
        "http",
        "token-2",
        "rt-1"
      );

      expect(result).toEqual({
        ok: false,
        existing: {
          workerId: "existing-worker-id",
          runtimeInstanceId: "docker-resource-1",
          status: "running",
        },
      });
      expect(prismaMocks.worker.findUnique).toHaveBeenCalledWith({
        where: {
          ownerId_runtimeId_isolationScope: {
            ownerId: "ws-1",
            runtimeId: "rt-1",
            isolationScope: "workspace",
          },
        },
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
          "worker-3",
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
          "worker-4",
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

  describe("findActiveByWorkerId", () => {
    it("returns the id, startToken, runtimeType, instanceId, isolationScope, ownerId and runtimeId when the worker has an active row", async () => {
      prisma.worker.findUnique.mockResolvedValue({
        id: "worker-1",
        startToken: "token-starting",
        runtimeType: "sandbox",
        instanceId: "inst-1",
        isolationScope: "workspace",
        ownerId: "owner-1",
        runtimeId: "rt-1",
      });

      const result = await repository.findActiveByWorkerId("worker-1");

      expect(prisma.worker.findUnique).toHaveBeenCalledWith({
        where: { id: "worker-1" },
        select: {
          id: true,
          startToken: true,
          runtimeType: true,
          instanceId: true,
          isolationScope: true,
          ownerId: true,
          runtimeId: true,
        },
      });
      expect(result).toEqual({
        id: "worker-1",
        startToken: "token-starting",
        runtimeType: "sandbox",
        instanceId: "inst-1",
        isolationScope: "workspace",
        ownerId: "owner-1",
        runtimeId: "rt-1",
      });
    });

    it("returns null when the worker has no active row", async () => {
      prisma.worker.findUnique.mockResolvedValue(null);

      const result = await repository.findActiveByWorkerId("worker-3");

      expect(result).toBeNull();
    });
  });

  describe("findRunningByRuntimeType", () => {
    it("finds all running rows for the given runtimeType", async () => {
      const prismaMocks = makePrismaMock();
      prismaMocks.worker.findMany.mockResolvedValue([
        {
          id: "rr-1",
          runtimeType: "native",
          isolationScope: "workspace",
          ownerId: "ws-1",
          instanceId: "4242:token",
        },
      ]);
      const repository = new WorkerRegistryRepository(prismaMocks as never);

      const result = await repository.findRunningByRuntimeType("native");

      expect(prismaMocks.worker.findMany).toHaveBeenCalledWith({
        where: { runtimeType: "native", status: "running" },
      });
      expect(result).toEqual([
        {
          id: "rr-1",
          runtimeType: "native",
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

// Worker 的复合唯一约束 (ownerId, runtimeId, isolationScope) 是真实 SQLite 约束
// (见 schema.prisma @@unique([ownerId, runtimeId, isolationScope]))——mocking prisma
// calls 无法验证,因此这个 suite 使用真实 SQLite 数据库。
describe("WorkerRegistryRepository — composite unique key (real sqlite)", () => {
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
  const targetRuntimeId = "managed-docker";
  const secondRuntimeId = "managed-native";

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
        source: "managed",
        runtimeType: "docker",
      },
    });
    await prisma.runtime.create({
      data: {
        id: secondRuntimeId,
        name: secondRuntimeId,
        source: "managed",
        runtimeType: "native",
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

  it("rejects a concurrent insertStarting for the same (owner, runtime, scope) instead of inserting a duplicate row", async () => {
    const first = await repository.insertStarting(
      baseInput,
      "worker-real-1",
      "inst-real-1",
      "http",
      "token-real-1",
      targetRuntimeId
    );
    expect(first).toEqual({ ok: true, workerId: "worker-real-1" });

    const second = await repository.insertStarting(
      baseInput,
      "worker-real-2",
      "inst-real-2",
      "http",
      "token-real-2",
      targetRuntimeId
    );
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.existing).toEqual({
        workerId: "worker-real-1",
        runtimeInstanceId: "inst-real-1",
        status: "starting",
      });
    }

    const rows = await prisma.worker.findMany({
      where: { ownerId: baseInput.ownerId },
    });
    expect(rows).toHaveLength(1);
  });

  it("allows a new insertStarting once the (owner, runtime, scope)'s previous row is physically removed on stop", async () => {
    await repository.insertStarting(
      baseInput,
      "worker-real-3",
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
      "worker-real-4",
      "inst-real-4",
      "http",
      "token-real-4",
      targetRuntimeId
    );

    expect(result).toEqual({ ok: true, workerId: "worker-real-4" });
    const rows = await prisma.worker.findMany({
      where: { ownerId: baseInput.ownerId },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("starting");
  });

  it("upsertRunning stores (owner, runtime, scope) uniquely, blocking a concurrent insertStarting", async () => {
    await repository.insertStarting(
      baseInput,
      "worker-real-5",
      "inst-real-5",
      "http",
      "token-real-5",
      targetRuntimeId
    );
    await repository.upsertRunning(
      baseInput,
      "worker-real-5",
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
      "worker-real-6",
      "inst-real-6",
      "http",
      "token-real-6",
      targetRuntimeId
    );
    expect(conflict.ok).toBe(false);
  });

  it("allows the same owner to have parallel workers on different runtimes", async () => {
    const first = await repository.insertStarting(
      baseInput,
      "worker-docker",
      "inst-docker",
      "http",
      "token-docker",
      targetRuntimeId
    );
    expect(first).toEqual({ ok: true, workerId: "worker-docker" });

    const second = await repository.insertStarting(
      { ...baseInput, workspaceId: "ws-real-2" },
      "worker-native",
      "inst-native",
      "http",
      "token-native",
      secondRuntimeId
    );
    expect(second).toEqual({ ok: true, workerId: "worker-native" });

    const rows = await prisma.worker.findMany({
      where: { ownerId: baseInput.ownerId },
    });
    expect(rows).toHaveLength(2);
  });
});
