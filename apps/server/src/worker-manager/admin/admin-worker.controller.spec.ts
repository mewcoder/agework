import { describe, expect, it, vi } from "vitest";
import { AdminWorkerController } from "./admin-worker.controller";

function makeController(
  workerManager: Record<string, unknown> = {},
  hostContract: Record<string, unknown> = {}
) {
  return new AdminWorkerController(
    {
      getRuntimePolicy: vi.fn(),
      getWorkerStats: vi.fn(),
      listResources: vi.fn(),
      stopWorkerInstance: vi.fn(),
      ...workerManager,
    } as never,
    {
      listWorkers: vi.fn().mockResolvedValue([]),
      stopWorker: vi.fn().mockResolvedValue(undefined),
      ...hostContract,
    } as never
  );
}

describe("AdminWorkerController", () => {
  it("delegates resource listing to WorkerManagerService", async () => {
    const listResources = vi
      .fn()
      .mockResolvedValue({ list: [], total: 0, pageNo: 1, pageSize: 10 });
    const controller = makeController({ listResources });

    const query = { status: "running", pageNo: 1, pageSize: 10 };
    await controller.listResources(query as never);

    expect(listResources).toHaveBeenCalledWith(query);
  });

  it("delegates stop to WorkerManagerService by id", async () => {
    const stopWorkerInstance = vi.fn().mockResolvedValue({ ok: true });
    const controller = makeController({ stopWorkerInstance });

    await expect(controller.stopResource({ id: "rr-1" })).resolves.toEqual({
      ok: true,
    });
    expect(stopWorkerInstance).toHaveBeenCalledWith("rr-1");
  });

  it("delegates policy and stats to WorkerManagerService", async () => {
    const getRuntimePolicy = vi.fn().mockReturnValue({ runtimeType: "native" });
    const getWorkerStats = vi.fn().mockResolvedValue({ activeWorkers: 0 });
    const controller = makeController({ getRuntimePolicy, getWorkerStats });

    controller.getRuntimePolicy();
    await controller.getWorkerStats();

    expect(getRuntimePolicy).toHaveBeenCalled();
    expect(getWorkerStats).toHaveBeenCalled();
  });

  it("listLiveWorkers delegates to hostContract.listWorkers", async () => {
    const listWorkers = vi.fn().mockResolvedValue([
      {
        id: "w-1",
        workerKey: "workspace:ws-1#native",
        runtimeType: "native",
        isolationScope: "workspace",
        ownerId: "ws-1",
        runtimeInstanceId: "ri-1",
        status: "running",
        expiresAt: null,
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z",
        workspaceBindings: [],
      },
    ]);
    const controller = makeController({}, { listWorkers });

    const result = await controller.listLiveWorkers();

    expect(listWorkers).toHaveBeenCalled();
    expect(result).toEqual({
      list: [
        expect.objectContaining({
          id: "w-1",
          workerKey: "workspace:ws-1#native",
          status: "running",
        }),
      ],
    });
  });

  it("listLiveWorkers returns empty list when no workers", async () => {
    const controller = makeController();

    const result = await controller.listLiveWorkers();

    expect(result).toEqual({ list: [] });
  });

  it("stopLiveWorker delegates to hostContract.stopWorker with workerKey", async () => {
    const stopWorker = vi.fn().mockResolvedValue(undefined);
    const controller = makeController({}, { stopWorker });

    const result = await controller.stopLiveWorker({
      workerKey: "workspace:ws-1#native",
    });

    expect(stopWorker).toHaveBeenCalledWith("workspace:ws-1#native");
    expect(result).toEqual({ ok: true });
  });
});
