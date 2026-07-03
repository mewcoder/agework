import { describe, it, expect, vi } from "vitest";
import { WorkspaceController } from "./workspace.controller";
import type { WorkspaceService } from "./workspace.service";
import type { JwtUser } from "../auth/decorators/current-user.decorator";

function makeController(overrides?: { service?: Partial<WorkspaceService> }) {
  const service = {
    list: vi.fn().mockResolvedValue([]),
    getCapabilities: vi.fn().mockResolvedValue({}),
    create: vi.fn().mockResolvedValue({ id: "ws-1" }),
    update: vi.fn().mockResolvedValue({ id: "ws-1" }),
    delete: vi.fn().mockResolvedValue(undefined),
    ...overrides?.service,
  };
  return {
    controller: new WorkspaceController(service as unknown as WorkspaceService),
    service,
  };
}

const mockUser: JwtUser = {
  userId: "user-1",
  username: "alice",
  role: "user",
  status: "active",
  mustChangePassword: false,
  sessionVersion: 1,
};

describe("WorkspaceController", () => {
  describe("list()", () => {
    it("delegates to workspaceService.list with userId", async () => {
      const { controller, service } = makeController();
      await controller.list(mockUser);
      expect(service.list).toHaveBeenCalledWith("user-1");
    });
  });

  describe("capabilities()", () => {
    it("delegates to workspaceService.capabilities", () => {
      const { controller, service } = makeController();
      void controller.capabilities();
      expect(service.getCapabilities).toHaveBeenCalled();
    });
  });

  describe("create()", () => {
    it("passes all body fields and userId to service", async () => {
      const { controller, service } = makeController();
      const body = {
        name: "my-ws",
        description: "test",
        rootPath: "/tmp",
        runtimeType: "local",
        isolationScope: "workspace",
      } as never;
      await controller.create(body, mockUser);
      expect(service.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: "user-1",
          name: "my-ws",
        })
      );
    });
  });

  describe("update()", () => {
    it("delegates to workspaceService.update", async () => {
      const { controller, service } = makeController();
      await controller.update(
        { id: "ws-1", name: "new", description: "d" },
        mockUser
      );
      expect(service.update).toHaveBeenCalledWith("user-1", "ws-1", "new", "d");
    });
  });

  describe("remove()", () => {
    it("delegates to workspaceService.delete", async () => {
      const { controller, service } = makeController();
      await controller.remove({ id: "ws-1" }, mockUser);
      expect(service.delete).toHaveBeenCalledWith("user-1", "ws-1");
    });
  });
});
