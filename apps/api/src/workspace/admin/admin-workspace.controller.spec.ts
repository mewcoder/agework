import { describe, it, expect, vi } from "vitest";
import { AdminWorkspaceController } from "./admin-workspace.controller";
import type { WorkspaceService } from "../workspace.service";

function makeController() {
  const service = {
    listAll: vi.fn().mockResolvedValue({ list: [] }),
    updateAny: vi.fn().mockResolvedValue({}),
  };
  return {
    controller: new AdminWorkspaceController(
      service as unknown as WorkspaceService
    ),
    service,
  };
}

describe("AdminWorkspaceController", () => {
  describe("listAll()", () => {
    it("passes pagination to workspaceService.listAll", async () => {
      const { controller, service } = makeController();
      await controller.listAll({ pageNo: 3, pageSize: 15 });
      expect(service.listAll).toHaveBeenCalledWith({ take: 15, skip: 30 });
    });

    it("uses defaults when pagination is omitted", async () => {
      const { controller, service } = makeController();
      await controller.listAll({});
      expect(service.listAll).toHaveBeenCalledWith({ take: 10, skip: 0 });
    });
  });

  describe("update()", () => {
    it("delegates to workspaceService.updateAny", async () => {
      const { controller, service } = makeController();
      await controller.update({
        id: "ws-1",
        name: "new",
        description: "d",
      });
      expect(service.updateAny).toHaveBeenCalledWith("ws-1", "new", "d");
    });
  });
});
