import { Reflector } from "@nestjs/core";
import { JwtService } from "@nestjs/jwt";
import type { ExecutionContext } from "@nestjs/common";
import { AuthService } from "./auth.service";
import { JwtAuthGuard } from "./guards/jwt-auth.guard";
import type { JwtUser } from "./decorators/current-user.decorator";
import type { SessionService } from "./session/session.service";
import { ConfigService } from "../config/config.service";
import type { UserService } from "../user/user.service";

/**
 * 覆盖 AuthService + JwtAuthGuard 自身的会话 / 鉴权逻辑：session bootstrap key 校验、
 * sessionVersion 失效、强制改密拦截、开发态免登录。UserService 全程手搓 mock，
 * 不构造 `user` 模块内部的 UserRepository / PasswordHasherService（那些由
 * user/user-security.spec.ts 覆盖）。
 */

function makeUsersMock() {
  return {
    authenticate: vi.fn(),
    setupSuperAdmin: vi.fn(),
    changePassword: vi.fn(),
    findActiveSessionUser: vi.fn().mockResolvedValue(null),
    findDevSuperAdminSessionUser: vi.fn().mockResolvedValue(null),
    getProfile: vi.fn(),
  };
}

function makeServices(users = makeUsersMock()) {
  const jwt = new JwtService({ secret: "test-secret" });
  const configService = new ConfigService({} as never);
  const sessions = {
    issue: vi.fn(async () => ({
      rawToken: "test-refresh-token",
      expiresAt: new Date(Date.now() + 60_000),
    })),
    rotate: vi.fn(),
    revoke: vi.fn(async () => {}),
    revokeAllForUser: vi.fn(async () => {}),
  } as unknown as SessionService;
  const auth = new AuthService(
    users as unknown as UserService,
    jwt,
    configService,
    sessions
  );
  const guard = new JwtAuthGuard(
    jwt,
    new Reflector(),
    users as unknown as UserService,
    configService
  );

  return { auth, guard, users, sessions, configService };
}

function contextForToken(
  token: string,
  path = "/api/v1/auth/query",
  method = "GET"
): ExecutionContext {
  const request = {
    headers: {
      authorization: `Bearer ${token}`,
    },
    method,
    originalUrl: path,
  };

  return {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
    getHandler: () => contextForToken,
    getClass: () => class TestController {},
  } as unknown as ExecutionContext;
}

function contextWithoutToken(
  path = "/api/v1/auth/query",
  method = "GET"
): ExecutionContext & { request: { user?: JwtUser } } {
  const request = {
    headers: {},
    method,
    originalUrl: path,
    user: undefined as JwtUser | undefined,
  };

  return {
    request,
    switchToHttp: () => ({
      getRequest: () => request,
    }),
    getHandler: () => contextWithoutToken,
    getClass: () => class TestController {},
  } as unknown as ExecutionContext & { request: { user?: JwtUser } };
}

/** AuthService 内部签发 token 用的用户形状（`id`，来自 UserService.authenticate/changePassword/setupSuperAdmin 的 UserDto）。 */
function tokenUser(overrides?: {
  id?: string;
  username?: string;
  role?: string;
  status?: string;
  mustChangePassword?: boolean;
  sessionVersion?: number;
}) {
  return {
    id: "user-1",
    username: "dave",
    role: "user",
    status: "active",
    mustChangePassword: false,
    sessionVersion: 1,
    ...overrides,
  };
}

/** JwtAuthGuard 校验会话用的用户形状（`userId`，来自 UserService.findActiveSessionUser 等）。 */
function sessionUser(overrides?: Partial<JwtUser>): JwtUser {
  return {
    userId: "user-1",
    username: "dave",
    role: "user",
    status: "active",
    mustChangePassword: false,
    sessionVersion: 1,
    ...overrides,
  };
}

describe("auth session and guard security flows", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalAdminInitKey = process.env.AGEWORK_PRIVATE_ADMIN_INIT_KEY;
  const originalDevAuthDisabled = process.env.AGEWORK_DEV_AUTH_DISABLED;

  afterEach(() => {
    restoreEnv("NODE_ENV", originalNodeEnv);
    restoreEnv("AGEWORK_PRIVATE_ADMIN_INIT_KEY", originalAdminInitKey);
    restoreEnv("AGEWORK_DEV_AUTH_DISABLED", originalDevAuthDisabled);
  });

  describe("production setup bootstrap key", () => {
    it("rejects setup when no bootstrap key is configured", async () => {
      const { auth } = makeServices();
      process.env.NODE_ENV = "production";
      delete process.env.AGEWORK_PRIVATE_ADMIN_INIT_KEY;

      await expect(auth.setupSuperAdmin("AdminInitPass1")).rejects.toThrow(
        "未配置 AGEWORK_PRIVATE_ADMIN_INIT_KEY"
      );
    });

    it("rejects setup when the bootstrap key is missing or wrong", async () => {
      const { auth } = makeServices();
      process.env.NODE_ENV = "production";
      process.env.AGEWORK_PRIVATE_ADMIN_INIT_KEY = "right-key";

      await expect(auth.setupSuperAdmin("AdminInitPass1")).rejects.toThrow(
        "初始化密钥无效"
      );
      await expect(
        auth.setupSuperAdmin("AdminInitPass1", "wrong-key")
      ).rejects.toThrow("初始化密钥无效");
    });

    it("creates the super admin when the bootstrap key matches", async () => {
      const { auth, users } = makeServices();
      process.env.NODE_ENV = "production";
      process.env.AGEWORK_PRIVATE_ADMIN_INIT_KEY = "right-key";
      users.setupSuperAdmin.mockResolvedValue({
        id: "admin",
        username: "admin",
        role: "super_admin",
        status: "active",
        mustChangePassword: false,
        sessionVersion: 1,
      });

      const session = await auth.setupSuperAdmin("AdminInitPass1", "right-key");
      expect(session.user).toMatchObject({
        username: "admin",
        role: "super_admin",
      });
    });

    it("does not require a bootstrap key outside production", async () => {
      const { auth, users } = makeServices();
      process.env.NODE_ENV = "development";
      delete process.env.AGEWORK_PRIVATE_ADMIN_INIT_KEY;
      users.setupSuperAdmin.mockResolvedValue({
        id: "admin",
        username: "admin",
        role: "super_admin",
        status: "active",
        mustChangePassword: false,
        sessionVersion: 1,
      });

      const session = await auth.setupSuperAdmin("AdminInitPass1");
      expect(session.user).toMatchObject({ username: "admin" });
    });
  });

  it("rejects tokens whose sessionVersion no longer matches the user record", async () => {
    const { auth, guard, users } = makeServices();
    let sessionVersion = 1;
    users.authenticate.mockResolvedValue(tokenUser({ sessionVersion }));
    users.findActiveSessionUser.mockImplementation(async () =>
      sessionUser({ sessionVersion })
    );

    const oldLogin = await auth.login("dave", "DavePass123");

    // 模拟改密后 sessionVersion 递增，旧 token 应立即失效
    sessionVersion = 2;
    users.changePassword.mockResolvedValue(tokenUser({ sessionVersion }));
    const newLogin = await auth.changePassword(
      "user-1",
      "DavePass123",
      "DaveNext123"
    );

    await expect(
      guard.canActivate(contextForToken(oldLogin.token))
    ).rejects.toThrow();
    await expect(
      guard.canActivate(contextForToken(newLogin.token))
    ).resolves.toBe(true);
  });

  it("blocks non-password endpoints while the current password must be changed", async () => {
    const { auth, guard, users } = makeServices();
    users.authenticate.mockResolvedValue(
      tokenUser({ mustChangePassword: true })
    );
    users.findActiveSessionUser.mockResolvedValue(
      sessionUser({ mustChangePassword: true })
    );

    const login = await auth.login("erin", "TempPass123");

    await expect(
      guard.canActivate(
        contextForToken(login.token, "/api/v1/admin/users/list")
      )
    ).rejects.toThrow();
    await expect(
      guard.canActivate(contextForToken(login.token, "/api/v1/auth/query"))
    ).resolves.toBe(true);
    await expect(
      guard.canActivate(
        contextForToken(login.token, "/api/v1/auth/update-password", "POST")
      )
    ).resolves.toBe(true);
  });

  it("uses the real admin user for dev auth disabled only in development", async () => {
    const { guard, users } = makeServices();
    process.env.NODE_ENV = "development";
    process.env.AGEWORK_DEV_AUTH_DISABLED = "true";
    users.findDevSuperAdminSessionUser.mockResolvedValue(
      sessionUser({
        userId: "admin-dev",
        username: "admin",
        role: "super_admin",
      })
    );

    const context = contextWithoutToken();
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(context.request.user).toMatchObject({
      userId: "admin-dev",
      username: "admin",
      role: "super_admin",
      status: "active",
    });

    process.env.NODE_ENV = "production";
    await expect(guard.canActivate(contextWithoutToken())).rejects.toThrow();
  });
});

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
