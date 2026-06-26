import { describe, it, expect, vi } from "vitest";
import { AdminUserController } from "./admin-user.controller";
import type { UserService } from "../user.service";
import type { JwtUser } from "../../auth/current-user.decorator";

function makeController(overrides?: { users?: Partial<UserService> }) {
  const users = {
    list: vi.fn().mockResolvedValue({ list: [] }),
    create: vi.fn().mockResolvedValue({ user: {}, temporaryPassword: "pw" }),
    approve: vi.fn().mockResolvedValue({}),
    update: vi.fn().mockResolvedValue({}),
    resetPassword: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue(undefined),
    ...overrides?.users,
  };
  return {
    controller: new AdminUserController(users as unknown as UserService),
    users,
  };
}

const mockUser: JwtUser = {
  userId: "admin-1",
  username: "manager",
  role: "admin",
  status: "active",
  mustChangePassword: false,
  sessionVersion: 1,
};

describe("AdminUserController", () => {
  describe("list()", () => {
    it("passes pagination to usersService.list", async () => {
      const { controller, users } = makeController();
      await controller.list(mockUser, "2", "20");
      expect(users.list).toHaveBeenCalledWith(mockUser, { take: 20, skip: 20 });
    });

    it("uses defaults when pagination is omitted", async () => {
      const { controller, users } = makeController();
      await controller.list(mockUser);
      expect(users.list).toHaveBeenCalledWith(mockUser, { take: 10, skip: 0 });
    });

    it("clamps pageSize to max 100", async () => {
      const { controller, users } = makeController();
      await controller.list(mockUser, "1", "500");
      expect(users.list).toHaveBeenCalledWith(mockUser, { take: 100, skip: 0 });
    });
  });

  describe("create()", () => {
    it("delegates to usersService.create", async () => {
      const { controller, users } = makeController();
      await controller.create({ username: "bob", role: "user" }, mockUser);
      expect(users.create).toHaveBeenCalledWith(mockUser, "bob", "user");
    });
  });

  describe("approve()", () => {
    it("delegates to usersService.approve", async () => {
      const { controller, users } = makeController();
      await controller.approve({ id: "user-1" }, mockUser);
      expect(users.approve).toHaveBeenCalledWith("user-1", mockUser);
    });
  });

  describe("update()", () => {
    it("delegates to usersService.update with all body fields", async () => {
      const { controller, users } = makeController();
      const body = { id: "user-1", role: "admin", status: "active" } as never;
      await controller.update(body, mockUser);
      expect(users.update).toHaveBeenCalledWith("user-1", body, mockUser);
    });
  });

  describe("updatePassword()", () => {
    it("delegates to usersService.resetPassword", async () => {
      const { controller, users } = makeController();
      await controller.updatePassword({ id: "user-1" }, mockUser);
      expect(users.resetPassword).toHaveBeenCalledWith("user-1", mockUser);
    });
  });

  describe("remove()", () => {
    it("delegates to usersService.delete", async () => {
      const { controller, users } = makeController();
      await controller.remove({ id: "user-1" }, mockUser);
      expect(users.delete).toHaveBeenCalledWith("user-1", mockUser);
    });
  });
});
