import { describe, it, expect, vi } from "vitest";
import { AdminModelProviderController } from "./admin-model-provider.controller";
import type { ModelProviderService } from "../model-provider.service";

function makeController() {
  const service = {
    listForAdmin: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockResolvedValue({ id: "mp-1" }),
    update: vi.fn().mockResolvedValue({}),
    setEnabled: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue(undefined),
    ping: vi.fn().mockResolvedValue({ ok: true }),
  };
  return {
    controller: new AdminModelProviderController(
      service as unknown as ModelProviderService
    ),
    service,
  };
}

describe("AdminModelProviderController", () => {
  it("list() delegates without params", async () => {
    const { controller, service } = makeController();
    await controller.list();
    expect(service.listForAdmin).toHaveBeenCalledWith();
  });

  it("create() delegates with all body fields", async () => {
    const { controller, service } = makeController();
    await controller.create({
      apiFormat: "anthropic",
      name: "provider",
      providerConfig: {},
    } as never);
    expect(service.create).toHaveBeenCalledWith("anthropic", "provider", {});
  });

  it("update() delegates with all body fields", async () => {
    const { controller, service } = makeController();
    await controller.update({
      id: "mp-1",
      name: "new",
      providerConfig: {},
    } as never);
    expect(service.update).toHaveBeenCalledWith("mp-1", "new", {});
  });

  it("setEnabled() delegates with id and isEnabled", async () => {
    const { controller, service } = makeController();
    await controller.setEnabled({ id: "mp-1", isEnabled: true });
    expect(service.setEnabled).toHaveBeenCalledWith("mp-1", true);
  });

  it("remove() delegates to service.delete", async () => {
    const { controller, service } = makeController();
    await controller.remove({ id: "mp-1" });
    expect(service.delete).toHaveBeenCalledWith("mp-1");
  });

  it("ping() delegates to service.ping", async () => {
    const { controller, service } = makeController();
    await controller.ping({ id: "mp-1" });
    expect(service.ping).toHaveBeenCalledWith("mp-1", true);
  });
});
