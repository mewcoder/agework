import { describe, it, expect, vi } from "vitest";
import { SystemController } from "./system.controller";
import type { SystemService } from "./system.service";

describe("SystemController", () => {
  it("delegates about() to SystemService", () => {
    const aboutResult = {
      platform: { name: "AgeWork", description: "desc", version: "1.0.0" },
      agents: [],
    };
    const service = {
      about: vi.fn().mockReturnValue(aboutResult),
    };
    const controller = new SystemController(
      service as unknown as SystemService
    );

    const result = controller.about();

    expect(service.about).toHaveBeenCalled();
    expect(result).toBe(aboutResult);
  });
});
