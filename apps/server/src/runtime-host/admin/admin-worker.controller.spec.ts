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

  it("getWorkerStats counts live pool entries from listWorkers", async () => {
    const listWorkers = vi
      .fn()
      .mockResolvedValue([{ status: "ready" }, { status: "starting" }]);
    const controller = makeController({}, { listWorkers });

    const result = await controller.getWorkerStats();

    expect(listWorkers).toHaveBeenCalled();
    expect(result).toEqual({ activeWorkers: 2 });
  });

  it("list delegates to hostContract.listWorkers", async () => {
    const listWorkers = vi.fn().mockResolvedValue([
      {
        runtimeHostId: "builtin",
        workerId: "w-1",
        workerKey: "workspace:ws-1#native",
        status: "ready",
      },
    ]);
    const controller = makeController({}, { listWorkers });

    const result = await controller.list();

    expect(listWorkers).toHaveBeenCalled();
    expect(result).toEqual({
      list: [
        expect.objectContaining({
          runtimeHostId: "builtin",
          workerId: "w-1",
          workerKey: "workspace:ws-1#native",
          status: "ready",
        }),
      ],
    });
  });

  it("stop delegates to hostContract.stopWorker with the target host and key", async () => {
    const stopWorker = vi.fn().mockResolvedValue(undefined);
    const controller = makeController({}, { stopWorker });

    const result = await controller.stop({
      runtimeHostId: "rt-1",
      workerKey: "workspace:ws-1#native",
    });

    expect(stopWorker).toHaveBeenCalledWith({
      runtimeHostId: "rt-1",
      key: "workspace:ws-1#native",
    });
    expect(result).toEqual({ ok: true });
  });

  it("stop maps contract failures to 502 (目标 Host 不可达)", async () => {
    const stopWorker = vi
      .fn()
      .mockRejectedValue(new Error("runtime rt-1 is not connected"));
    const controller = makeController({}, { stopWorker });

    await expect(
      controller.stop({
        runtimeHostId: "rt-1",
        workerKey: "workspace:ws-1#native",
      })
    ).rejects.toMatchObject({
      status: 502,
      message: expect.stringContaining("rt-1 is not connected"),
    });
  });
});
