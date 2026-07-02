import { describe, it, expect, vi } from "vitest";
import { AdminConfigController } from "./admin-config.controller";
import type { ConfigService } from "../config.service";

function makeController() {
  const configService = {
    listSettings: vi.fn().mockResolvedValue([]),
    setSetting: vi.fn().mockResolvedValue({}),
    resetSetting: vi.fn().mockResolvedValue({}),
  };
  return {
    controller: new AdminConfigController(
      configService as unknown as ConfigService
    ),
    configService,
  };
}

describe("AdminConfigController", () => {
  it("list() delegates to configService.listSettings", () => {
    const { controller, configService } = makeController();
    void controller.list();
    expect(configService.listSettings).toHaveBeenCalled();
  });

  it("set() delegates to configService.setSetting with key, value, userId", async () => {
    const { controller, configService } = makeController();
    await controller.set(
      { key: "theme", value: "dark" },
      {
        userId: "user-1",
      }
    );
    expect(configService.setSetting).toHaveBeenCalledWith(
      "theme",
      "dark",
      "user-1"
    );
  });

  it("reset() delegates to configService.resetSetting with key", async () => {
    const { controller, configService } = makeController();
    await controller.reset({ key: "theme" });
    expect(configService.resetSetting).toHaveBeenCalledWith("theme");
  });
});
