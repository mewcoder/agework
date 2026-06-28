import { describe, expect, it, vi } from "vitest";
import { AdminRuntimeController } from "./admin-runtime.controller";

function makeController(runtimeService: Record<string, unknown> = {}) {
  return new AdminRuntimeController({
    getRuntimePolicy: vi.fn(),
    getRuntimeStats: vi.fn(),
    listRuntimeResources: vi.fn(),
    stopRuntimeInstance: vi.fn(),
    ...runtimeService,
  } as never);
}

describe("AdminRuntimeController", () => {
  it("delegates resource listing to the runtime service", async () => {
    const listRuntimeResources = vi
      .fn()
      .mockResolvedValue({ list: [], total: 0, pageNo: 1, pageSize: 10 });
    const controller = makeController({ listRuntimeResources });

    const query = { status: "running", pageNo: 1, pageSize: 10 };
    await controller.listResources(query as never);

    expect(listRuntimeResources).toHaveBeenCalledWith(query);
  });

  it("delegates stop to the runtime service by id", async () => {
    const stopRuntimeInstance = vi.fn().mockResolvedValue({ ok: true });
    const controller = makeController({ stopRuntimeInstance });

    await expect(controller.stopResource({ id: "rr-1" })).resolves.toEqual({
      ok: true,
    });
    expect(stopRuntimeInstance).toHaveBeenCalledWith("rr-1");
  });

  it("delegates policy and stats to the runtime service", () => {
    const getRuntimePolicy = vi.fn().mockReturnValue({ runtimeType: "local" });
    const getRuntimeStats = vi.fn().mockResolvedValue({ activeRuntimes: 0 });
    const controller = makeController({ getRuntimePolicy, getRuntimeStats });

    controller.getRuntimePolicy();
    controller.getRuntimeStats();

    expect(getRuntimePolicy).toHaveBeenCalled();
    expect(getRuntimeStats).toHaveBeenCalled();
  });
});
