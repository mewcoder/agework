import { describe, expect, it, vi } from "vitest";
import { AdminWorkerController } from "./admin-worker.controller";

function makeController(workerManager: Record<string, unknown> = {}) {
  return new AdminWorkerController({
    getRuntimePolicy: vi.fn(),
    getWorkerStats: vi.fn(),
    listResources: vi.fn(),
    stopWorkerInstance: vi.fn(),
    ...workerManager,
  } as never);
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
});
