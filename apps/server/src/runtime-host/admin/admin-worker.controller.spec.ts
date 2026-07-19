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
          isolation: { scope: "workspace", subjectId: "ws-1" },
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
          status: "ready",
        }),
      ],
    });
  });

  it("stop delegates to RuntimeHostService.stopWorkerForAdmin with host and workerId", async () => {
    const stopWorkerForAdmin = vi.fn().mockResolvedValue(undefined);
    const controller = makeController({ stopWorkerForAdmin });

    const result = await controller.stop({
      runtimeHostId: "rt-1",
      workerId: "w-1",
    });

    expect(stopWorkerForAdmin).toHaveBeenCalledWith("rt-1", "w-1");
    expect(result).toEqual({ ok: true });
  });
});
