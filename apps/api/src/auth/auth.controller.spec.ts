import { describe, it, expect, vi } from "vitest";
import { AuthController } from "./auth.controller";
import type { AuthService } from "./auth.service";
import type { ConfigService } from "../config/config.service";
import type { JwtUser } from "./current-user.decorator";

function makeController(overrides?: {
  auth?: Partial<AuthService>;
  config?: Partial<ConfigService>;
}) {
  const auth = {
    login: vi.fn().mockResolvedValue({ token: "jwt", user: { id: "1" } }),
    register: vi.fn().mockResolvedValue({ id: "1", username: "new" }),
    setupSuperAdmin: vi
      .fn()
      .mockResolvedValue({ token: "jwt", user: { id: "1" } }),
    me: vi.fn().mockResolvedValue({ id: "1", username: "me" }),
    changePassword: vi
      .fn()
      .mockResolvedValue({ token: "jwt", user: { id: "1" } }),
    completePasswordChange: vi
      .fn()
      .mockResolvedValue({ token: "jwt", user: { id: "1" } }),
    isSetupRequired: vi.fn().mockResolvedValue(false),
    ...overrides?.auth,
  };
  const config = {
    getAppName: vi.fn().mockReturnValue("AgeWork"),
    ...overrides?.config,
  };
  return {
    controller: new AuthController(
      auth as unknown as AuthService,
      config as unknown as ConfigService
    ),
    auth,
    config,
  };
}

const mockUser: JwtUser = {
  userId: "user-1",
  username: "testuser",
  role: "user",
  status: "active",
  mustChangePassword: false,
  sessionVersion: 1,
};

describe("AuthController", () => {
  describe("login()", () => {
    it("delegates to authService.login", async () => {
      const { controller, auth } = makeController();
      await controller.login({ username: "alice", password: "pass123" });
      expect(auth.login).toHaveBeenCalledWith("alice", "pass123");
    });
  });

  describe("register()", () => {
    it("delegates to authService.register", async () => {
      const { controller, auth } = makeController();
      await controller.register({ username: "bob", password: "pass123" });
      expect(auth.register).toHaveBeenCalledWith("bob", "pass123");
    });
  });

  describe("setup()", () => {
    it("delegates to authService.setupSuperAdmin", async () => {
      const { controller, auth } = makeController();
      await controller.setup({ newPassword: "AdminPass1" });
      expect(auth.setupSuperAdmin).toHaveBeenCalledWith("AdminPass1");
    });
  });

  describe("me()", () => {
    it("delegates to authService.me with userId", async () => {
      const { controller, auth } = makeController();
      await controller.me(mockUser);
      expect(auth.me).toHaveBeenCalledWith("user-1");
    });
  });

  describe("updatePassword()", () => {
    it("calls completePasswordChange when currentPassword is undefined", async () => {
      const { controller, auth } = makeController();
      await controller.updatePassword({ newPassword: "NewPass1" }, mockUser);
      expect(auth.completePasswordChange).toHaveBeenCalledWith(
        "user-1",
        "NewPass1"
      );
      expect(auth.changePassword).not.toHaveBeenCalled();
    });

    it("calls changePassword when currentPassword is provided", async () => {
      const { controller, auth } = makeController();
      await controller.updatePassword(
        { currentPassword: "OldPass1", newPassword: "NewPass1" },
        mockUser
      );
      expect(auth.changePassword).toHaveBeenCalledWith(
        "user-1",
        "OldPass1",
        "NewPass1"
      );
      expect(auth.completePasswordChange).not.toHaveBeenCalled();
    });
  });

  describe("config()", () => {
    it("returns app config with auth info", async () => {
      const { controller, auth, config } = makeController();
      const result = await controller.config();

      expect(config.getAppName).toHaveBeenCalled();
      expect(auth.isSetupRequired).toHaveBeenCalled();
      expect(result).toMatchObject({
        appName: "AgeWork",
        registrationMode: "approval",
      });
      expect(typeof result.authRequired).toBe("boolean");
    });
  });
});
