import { describe, expect, it, vi } from "vitest";
import { AdminWorkerController } from "./admin-worker.controller";

function makeController(
  runtimeService: Record<string, unknown> = {},
  hostContract: Record<string, unknown> = {}
) {
  return new AdminWorkerController(
    {
      getRuntimePolicy: vi
        .fn()
        .mockReturnValue({ defaultRuntimeType: "native" }),
      ...runtimeService,
    } as never,
    {
      listWorkers: vi.fn().mockResolvedValue([]),
      stopWorker: vi.fn().mockResolvedValue(undefined),
      ...hostContract,
    } as never
  );
}

describe("AdminWorkerController", () => {
  it("delegates policy to RuntimeService", () => {
    const getRuntimePolicy = vi
      .fn()
      .mockReturnValue({ defaultRuntimeType: "native" });
    const controller = makeController({ getRuntimePolicy });

    controller.getRuntimePolicy();

    expect(getRuntimePolicy).toHaveBeenCalled();
  });

  it("getWorkerStats counts running workers from listWorkers", async () => {
    const listWorkers = vi
      .fn()
      .mockResolvedValue([
        { status: "running" },
        { status: "running" },
        { status: "stopped" },
      ]);
    const controller = makeController({}, { listWorkers });

    const result = await controller.getWorkerStats();

    expect(listWorkers).toHaveBeenCalled();
    expect(result).toEqual({ activeWorkers: 2 });
  });

  it("listResources delegates to hostContract.listWorkers", async () => {
    const listWorkers = vi.fn().mockResolvedValue([
      {
        id: "w-1",
        workerKey: "workspace:ws-1#native",
        status: "running",
      },
    ]);
    const controller = makeController({}, { listWorkers });

    const result = await controller.listResources();

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

  it("stopWorker delegates to hostContract.stopWorker with workerKey", async () => {
    const stopWorker = vi.fn().mockResolvedValue(undefined);
    const controller = makeController({}, { stopWorker });

    const result = await controller.stopWorker({
      workerKey: "workspace:ws-1#native",
    });

    expect(stopWorker).toHaveBeenCalledWith("workspace:ws-1#native");
    expect(result).toEqual({ ok: true });
  });
});
