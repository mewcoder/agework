import { describe, it, expect, vi } from "vitest";
import { AuthController } from "./auth.controller";
import type { AuthService } from "./auth.service";
import type { JwtUser } from "./decorators/current-user.decorator";

function makeController(overrides?: {
  auth?: Partial<AuthService>;
}) {
  const session = { token: "jwt", refreshToken: "rt", user: { id: "1" } };
  const auth = {
    login: vi.fn().mockResolvedValue(session),
    register: vi.fn().mockResolvedValue({ id: "1", username: "new" }),
    setupSuperAdmin: vi.fn().mockResolvedValue(session),
    me: vi.fn().mockResolvedValue({ id: "1", username: "me" }),
    changePassword: vi.fn().mockResolvedValue(session),
    completePasswordChange: vi.fn().mockResolvedValue(session),
    refresh: vi.fn().mockResolvedValue(session),
    logout: vi.fn().mockResolvedValue(undefined),
    isSetupRequired: vi.fn().mockResolvedValue(false),
    config: vi.fn().mockResolvedValue({
      authRequired: true,
      appName: "AgeWork",
      registrationMode: "approval",
      setupRequired: false,
    }),
    ...overrides?.auth,
  };
  return {
    controller: new AuthController(auth as unknown as AuthService),
    auth,
  };
}

function makeRes() {
  return {
    cookie: vi.fn(),
    clearCookie: vi.fn(),
  } as unknown as Parameters<AuthController["login"]>[1];
}

function makeReq(refreshCookie?: string) {
  return {
    cookies: refreshCookie ? { agework_rt: refreshCookie } : {},
  } as unknown as Parameters<AuthController["refresh"]>[0];
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
    it("delegates to authService.login and sets the refresh cookie", async () => {
      const { controller, auth } = makeController();
      const res = makeRes();
      const result = await controller.login(
        { username: "alice", password: "pass123" },
        res
      );
      expect(auth.login).toHaveBeenCalledWith("alice", "pass123");
      expect(res.cookie).toHaveBeenCalledWith(
        "agework_rt",
        "rt",
        expect.objectContaining({ httpOnly: true })
      );
      // refreshToken 不出现在响应体里
      expect(result).toEqual({ token: "jwt", user: { id: "1" } });
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
      await controller.setup({ newPassword: "AdminPass1" }, makeRes());
      expect(auth.setupSuperAdmin).toHaveBeenCalledWith("AdminPass1", undefined);
    });
  });

  describe("refresh()", () => {
    it("rotates using the refresh cookie and sets a new one", async () => {
      const { controller, auth } = makeController();
      const res = makeRes();
      await controller.refresh(makeReq("old-rt"), res);
      expect(auth.refresh).toHaveBeenCalledWith("old-rt");
      expect(res.cookie).toHaveBeenCalledWith(
        "agework_rt",
        "rt",
        expect.objectContaining({ httpOnly: true })
      );
    });

    it("rejects and clears the cookie when no refresh cookie is present", async () => {
      const { controller, auth } = makeController();
      const res = makeRes();
      await expect(controller.refresh(makeReq(), res)).rejects.toThrow();
      expect(auth.refresh).not.toHaveBeenCalled();
      expect(res.clearCookie).toHaveBeenCalledWith("agework_rt", expect.any(Object));
    });
  });

  describe("logout()", () => {
    it("revokes the session and clears the cookie", async () => {
      const { controller, auth } = makeController();
      const res = makeRes();
      const result = await controller.logout(makeReq("rt-1"), res);
      expect(auth.logout).toHaveBeenCalledWith("rt-1");
      expect(res.clearCookie).toHaveBeenCalledWith("agework_rt", expect.any(Object));
      expect(result).toEqual({ ok: true });
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
      await controller.updatePassword(
        { newPassword: "NewPass1" },
        mockUser,
        makeRes()
      );
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
        mockUser,
        makeRes()
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
    it("delegates to authService.config", async () => {
      const { controller, auth } = makeController();
      const result = await controller.config();

      expect(auth.config).toHaveBeenCalled();
      expect(result).toMatchObject({
        appName: "AgeWork",
        registrationMode: "approval",
      });
    });
  });
});
