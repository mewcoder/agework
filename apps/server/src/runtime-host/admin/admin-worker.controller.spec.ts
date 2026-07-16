import { describe, expect, it, vi } from "vitest";
import { AdminWorkerController } from "./admin-worker.controller";
import type { RuntimeHostService } from "../runtime-host.service";

function makeController(service: Partial<RuntimeHostService> = {}) {
  return new AdminWorkerController({
    listWorkersForAdmin: vi.fn().mockResolvedValue({ list: [] }),
    stopWorkerForAdmin: vi.fn().mockResolvedValue(undefined),
    ...service,
  } as unknown as RuntimeHostService);
}

describe("AdminWorkerController", () => {
  it("list delegates to RuntimeHostService.listWorkersForAdmin", async () => {
    const listWorkersForAdmin = vi.fn().mockResolvedValue({
      list: [
        {
          runtimeHostId: "builtin",
          workerId: "w-1",
          workerKey: "workspace:ws-1#native",
          status: "ready",
        },
      ],
    });
    const controller = makeController({ listWorkersForAdmin });

    const result = await controller.list();

    expect(listWorkersForAdmin).toHaveBeenCalled();
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

  it("stop delegates to RuntimeHostService.stopWorkerForAdmin with host and key", async () => {
    const stopWorkerForAdmin = vi.fn().mockResolvedValue(undefined);
    const controller = makeController({ stopWorkerForAdmin });

    const result = await controller.stop({
      runtimeHostId: "rt-1",
      workerKey: "workspace:ws-1#native",
    });

    expect(stopWorkerForAdmin).toHaveBeenCalledWith(
      "rt-1",
      "workspace:ws-1#native"
    );
    expect(result).toEqual({ ok: true });
  });
});
