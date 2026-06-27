vi.mock("../prisma/prisma.service", () => ({
  PrismaService: class PrismaService {},
}));

import { Reflector } from "@nestjs/core";
import { JwtService } from "@nestjs/jwt";
import type { ExecutionContext } from "@nestjs/common";
import { AuthService } from "./auth.service";
import { JwtAuthGuard } from "./guards/jwt-auth.guard";
import type { JwtUser } from "./decorators/current-user.decorator";
import { PrismaService } from "../prisma/prisma.service";
import { SystemInitService } from "../system/init/system-init.service";
import { UserService } from "../users/user.service";
import { UserRepository } from "../users/user.repository";
import { SUPER_ADMIN_USERNAME } from "../users/credentials/user-credentials";
import { PasswordHasherService } from "../users/credentials/password-hasher.service";
import { ConfigService } from "../config/config.service";
import { SystemSettingRepository } from "../config/system-setting.repository";

const INITIAL_PASSWORD_TTL_MS = 72 * 60 * 60 * 1000;
const RESET_PASSWORD_TTL_MS = 24 * 60 * 60 * 1000;
const NEXT_ADMIN_PASSWORD = "Next2026x";

type TestUser = {
  id: string;
  username: string;
  passwordHash: string;
  role: string;
  status: string;
  mustChangePassword: boolean;
  passwordKind: string;
  passwordExpiresAt: Date | null;
  passwordUpdatedAt: Date | null;
  passwordResetAt: Date | null;
  passwordResetById: string | null;
  approvedAt: Date | null;
  approvedById: string | null;
  lastLoginAt: Date | null;
  sessionVersion: number;
  failedLoginCount: number;
  lockedUntil: Date | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
};

type WhereValue = string | number | boolean | Date | null | { in: unknown[] };
type UserWhere = Partial<Record<keyof TestUser, WhereValue>>;
type UserSelect = Partial<Record<keyof TestUser, boolean>>;
type UserData = Partial<Record<keyof TestUser, unknown>>;

class MemoryPrisma {
  private nextId = 1;
  private users: TestUser[] = [];

  user = {
    count: (args?: { where?: UserWhere }) =>
      Promise.resolve(
        this.users.filter((user) => this.matches(user, args?.where)).length
      ),
    findUnique: (args: { where: UserWhere; select?: UserSelect }) => {
      const user = this.users.find((candidate) =>
        this.matches(candidate, args.where)
      );
      return Promise.resolve(this.pick(user, args.select));
    },
    findFirst: (args: { where?: UserWhere; select?: UserSelect }) => {
      const user = this.users.find((candidate) =>
        this.matches(candidate, args.where)
      );
      return Promise.resolve(this.pick(user, args.select));
    },
    findMany: (args?: {
      where?: UserWhere;
      select?: UserSelect;
      orderBy?: { createdAt?: "asc" | "desc" };
    }) => {
      const users = this.users
        .filter((user) => this.matches(user, args?.where))
        .sort((a, b) =>
          args?.orderBy?.createdAt === "desc"
            ? b.createdAt.getTime() - a.createdAt.getTime()
            : a.createdAt.getTime() - b.createdAt.getTime()
        );
      return Promise.resolve(
        users.map((user) => this.pick(user, args?.select))
      );
    },
    create: (args: { data: UserData; select?: UserSelect }) => {
      const now = new Date();
      const user: TestUser = {
        id:
          typeof args.data.id === "string"
            ? args.data.id
            : `user-${this.nextId++}`,
        username: requiredString(args.data.username, "username"),
        passwordHash: requiredString(args.data.passwordHash, "passwordHash"),
        role: optionalString(args.data.role, "user"),
        status: optionalString(args.data.status, "active"),
        mustChangePassword: Boolean(args.data.mustChangePassword ?? false),
        passwordKind: optionalString(args.data.passwordKind, "user_set"),
        passwordExpiresAt: nullableDate(args.data.passwordExpiresAt),
        passwordUpdatedAt: nullableDate(args.data.passwordUpdatedAt),
        passwordResetAt: nullableDate(args.data.passwordResetAt),
        passwordResetById: nullableString(args.data.passwordResetById),
        approvedAt: nullableDate(args.data.approvedAt),
        approvedById: nullableString(args.data.approvedById),
        lastLoginAt: nullableDate(args.data.lastLoginAt),
        sessionVersion: Number(args.data.sessionVersion ?? 1),
        failedLoginCount: Number(args.data.failedLoginCount ?? 0),
        lockedUntil: nullableDate(args.data.lockedUntil),
        createdAt: now,
        updatedAt: now,
        deletedAt: nullableDate(args.data.deletedAt),
      };
      this.users.push(user);
      return Promise.resolve(this.pick(user, args.select));
    },
    update: (args: {
      where: UserWhere;
      data: UserData;
      select?: UserSelect;
    }) => {
      const user = this.users.find((candidate) =>
        this.matches(candidate, args.where)
      );
      if (!user) throw new Error("User not found");

      for (const [key, value] of Object.entries(args.data)) {
        const field = key as keyof TestUser;
        if (isIncrement(value)) {
          user[field] = (Number(user[field]) + value.increment) as never;
        } else {
          user[field] = value as never;
        }
      }
      user.updatedAt = new Date();
      return Promise.resolve(this.pick(user, args.select));
    },
  };

  systemSetting = {
    findUnique: () => Promise.resolve(null),
    create: () => Promise.resolve(undefined),
  };

  getUser(username: string) {
    return this.users.find((user) => user.username === username);
  }

  private matches(user: TestUser, where?: UserWhere) {
    if (!where) return true;
    return Object.entries(where).every(([key, expected]) => {
      const actual = user[key as keyof TestUser];
      if (isInFilter(expected)) return expected.in.includes(actual);
      return actual === expected;
    });
  }

  private pick(user: TestUser | undefined, select?: UserSelect) {
    if (!user) return null;
    if (!select) return { ...user };

    const result: Partial<TestUser> = {};
    for (const [key, enabled] of Object.entries(select)) {
      if (enabled) {
        result[key as keyof TestUser] = user[key as keyof TestUser] as never;
      }
    }
    return result;
  }
}

function isInFilter(value: unknown): value is { in: unknown[] } {
  return Boolean(value && typeof value === "object" && "in" in value);
}

function isIncrement(value: unknown): value is { increment: number } {
  return Boolean(value && typeof value === "object" && "increment" in value);
}

function nullableDate(value: unknown) {
  return value instanceof Date ? value : null;
}

function nullableString(value: unknown) {
  return typeof value === "string" ? value : null;
}

function requiredString(value: unknown, field: string) {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  return value;
}

function optionalString(value: unknown, fallback: string) {
  return typeof value === "string" ? value : fallback;
}

function makeServices() {
  const prisma = new MemoryPrisma();
  const jwt = new JwtService({ secret: "test-secret" });
  const passwordHasher = new PasswordHasherService();
  const configService = new ConfigService(
    new SystemSettingRepository(prisma as unknown as PrismaService)
  );
  const users = new UserService(
    new UserRepository(prisma as unknown as PrismaService),
    passwordHasher,
    {
      emit: vi.fn(),
    } as never
  );
  const auth = new AuthService(users, jwt, configService);
  const systemInitialization = new SystemInitService(users, configService);
  const guard = new JwtAuthGuard(jwt, new Reflector(), users, configService);

  return {
    auth,
    guard,
    passwordHasher,
    prisma,
    systemInitialization,
    users,
    configService,
  };
}

async function seedSuperAdmin(
  passwordHasher: PasswordHasherService,
  prisma: MemoryPrisma,
  password = "AdminInitPass1"
) {
  await prisma.user.create({
    data: {
      id: "admin",
      username: SUPER_ADMIN_USERNAME,
      passwordHash: await passwordHasher.hash(password),
      role: "super_admin",
      status: "active",
      mustChangePassword: false,
      passwordKind: "user_set",
      passwordUpdatedAt: new Date(),
      approvedAt: new Date(),
    },
  });
}

function superAdminUser(): JwtUser {
  return {
    userId: "super-admin-1",
    username: "admin",
    role: "super_admin",
    status: "active",
    mustChangePassword: false,
    sessionVersion: 1,
  };
}

function adminUser(): JwtUser {
  return {
    userId: "admin-1",
    username: "manager",
    role: "admin",
    status: "active",
    mustChangePassword: false,
    sessionVersion: 1,
  };
}

function expectExpiresNear(
  expiresAt: string | Date | null,
  startedAt: Date,
  ttlMs: number
) {
  expect(expiresAt).toBeTruthy();
  const expiresTime =
    expiresAt instanceof Date
      ? expiresAt.getTime()
      : new Date(String(expiresAt)).getTime();
  expect(expiresTime).toBeGreaterThanOrEqual(
    startedAt.getTime() + ttlMs - 3000
  );
  expect(expiresTime).toBeLessThanOrEqual(Date.now() + ttlMs + 3000);
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

describe("auth and user management security flows", () => {
  const originalEnv = {
    AGEWORK_DEV_AUTH_DISABLED: process.env.AGEWORK_DEV_AUTH_DISABLED,
    AGEWORK_PRIVATE_JWT_SECRET: process.env.AGEWORK_PRIVATE_JWT_SECRET,
    NODE_ENV: process.env.NODE_ENV,
  };

  beforeEach(() => {
    process.env.NODE_ENV = "test";
    process.env.AGEWORK_DEV_AUTH_DISABLED = "false";
    process.env.AGEWORK_PRIVATE_JWT_SECRET = "test-secret";
  });

  afterEach(() => {
    restoreEnv(
      "AGEWORK_DEV_AUTH_DISABLED",
      originalEnv.AGEWORK_DEV_AUTH_DISABLED
    );
    restoreEnv(
      "AGEWORK_PRIVATE_JWT_SECRET",
      originalEnv.AGEWORK_PRIVATE_JWT_SECRET
    );
    restoreEnv("NODE_ENV", originalEnv.NODE_ENV);
  });

  it("creates the fixed admin super admin for dev auth disabled without exposing an initial password", async () => {
    const { prisma, systemInitialization } = makeServices();
    process.env.NODE_ENV = "development";
    process.env.AGEWORK_DEV_AUTH_DISABLED = "true";

    await systemInitialization.onApplicationBootstrap();

    const admin = prisma.getUser("admin");
    expect(admin).toMatchObject({
      role: "super_admin",
      status: "active",
      mustChangePassword: false,
      passwordKind: "dev_auth_disabled",
      sessionVersion: 1,
    });
    expect(admin?.passwordExpiresAt).toBeNull();
  });

  it("allows startup before setup and creates admin only after setup", async () => {
    const { auth, prisma } = makeServices();

    await expect(auth.isSetupRequired()).resolves.toBe(true);
    expect(prisma.getUser("admin")).toBeUndefined();

    const session = await auth.setupSuperAdmin("AdminInitPass1");

    expect(session.user).toMatchObject({
      username: "admin",
      role: "super_admin",
      status: "active",
      mustChangePassword: false,
      passwordKind: "user_set",
    });
    expect(prisma.getUser("admin")).toMatchObject({
      username: "admin",
      role: "super_admin",
      status: "active",
    });
    await expect(auth.isSetupRequired()).resolves.toBe(false);
    await expect(auth.setupSuperAdmin("AdminInitPass2")).rejects.toThrow(
      "系统已初始化"
    );
  });

  it("validates usernames and passwords before registration", async () => {
    const { auth } = makeServices();

    await expect(auth.register("ab", "UserPass123")).rejects.toThrow(
      "用户名至少需要"
    );
    await expect(auth.register("valid_user", "short")).rejects.toThrow(
      "密码至少需要"
    );
    await expect(auth.register("numbers", "12345678")).rejects.toThrow(
      "密码需要同时包含字母和数字"
    );
    await expect(auth.register("letters", "abcdefgh")).rejects.toThrow(
      "密码需要同时包含字母和数字"
    );
    await expect(auth.register("SameName1", "SameName1")).rejects.toThrow(
      "密码不能和用户名相同"
    );
    await expect(
      auth.register("common_user", "password1")
    ).resolves.toMatchObject({
      username: "common_user",
      status: "pending",
    });
  });

  it("keeps self-registered users pending without forcing password changes after approval", async () => {
    const { auth, users } = makeServices();

    const registered = await auth.register("alice", "AlicePass123");
    expect(registered).toMatchObject({
      role: "user",
      status: "pending",
      mustChangePassword: false,
      passwordKind: "user_set",
    });
    await expect(auth.login("alice", "AlicePass123")).rejects.toThrow(
      "账号待管理员审批"
    );

    await users.approve(registered.id, superAdminUser());

    const login = await auth.login("alice", "AlicePass123");
    expect(login.user).toMatchObject({
      status: "active",
      mustChangePassword: false,
    });
  });

  it("generates 72-hour initial passwords for admin-created accounts", async () => {
    const { auth, users } = makeServices();
    const startedAt = new Date();

    const created = await users.create(superAdminUser(), "manager", "admin");

    expect(created.temporaryPassword).toEqual(expect.any(String));
    expect(created.user).toMatchObject({
      role: "admin",
      status: "active",
      mustChangePassword: true,
      passwordKind: "initial",
    });
    expectExpiresNear(
      created.passwordExpiresAt,
      startedAt,
      INITIAL_PASSWORD_TTL_MS
    );

    const login = await auth.login("manager", created.temporaryPassword);
    expect(login.user.mustChangePassword).toBe(true);
  });

  it("rejects expired initial or temporary passwords during login", async () => {
    const { auth, prisma, users } = makeServices();
    const created = await users.create(
      superAdminUser(),
      "expired_user",
      "user"
    );

    await prisma.user.update({
      where: { id: created.user.id },
      data: { passwordExpiresAt: new Date(Date.now() - 1000) },
    });

    await expect(
      auth.login("expired_user", created.temporaryPassword)
    ).rejects.toThrow("临时密码已过期");
  });

  it("creates 24-hour temporary passwords during admin reset and invalidates the old password", async () => {
    const { auth, users } = makeServices();
    const created = await users.create(superAdminUser(), "bob", "user");
    const startedAt = new Date();

    const reset = await users.resetPassword(created.user.id, adminUser());

    expect(reset.temporaryPassword).toEqual(expect.any(String));
    expect(reset.user).toMatchObject({
      mustChangePassword: true,
      passwordKind: "temporary",
    });
    expectExpiresNear(
      reset.passwordExpiresAt,
      startedAt,
      RESET_PASSWORD_TTL_MS
    );
    await expect(auth.login("bob", created.temporaryPassword)).rejects.toThrow(
      "用户名或密码错误"
    );

    const login = await auth.login("bob", reset.temporaryPassword);
    expect(login.user.mustChangePassword).toBe(true);
  });

  it("clears temporary password state and increments sessionVersion after forced password change", async () => {
    const { auth, users } = makeServices();
    const created = await users.create(superAdminUser(), "carol", "user");
    const login = await auth.login("carol", created.temporaryPassword);

    const changed = await auth.completePasswordChange(
      created.user.id,
      "CarolPass123"
    );

    expect(login.user.sessionVersion).toBe(1);
    expect(changed.user).toMatchObject({
      mustChangePassword: false,
      passwordKind: "user_set",
      passwordExpiresAt: null,
      sessionVersion: 2,
    });
    await expect(
      auth.login("carol", created.temporaryPassword)
    ).rejects.toThrow("用户名或密码错误");
    await expect(auth.login("carol", "CarolPass123")).resolves.toMatchObject({
      user: { mustChangePassword: false },
    });
  });

  it("rejects forced password changes when the account does not require one", async () => {
    const { auth, users } = makeServices();

    const created = await users.create(superAdminUser(), "ready_user", "user");
    const changed = await auth.completePasswordChange(
      created.user.id,
      "ReadyPass123"
    );

    await expect(
      auth.completePasswordChange(changed.user.id, "ReadyPass456")
    ).rejects.toThrow("当前账号不需要强制修改密码");
  });

  it("rejects tokens whose sessionVersion no longer matches the user record", async () => {
    const { auth, guard, users } = makeServices();
    const created = await users.create(superAdminUser(), "dave", "user");
    const oldLogin = await auth.login("dave", created.temporaryPassword);
    const newLogin = await auth.changePassword(
      created.user.id,
      created.temporaryPassword,
      "DavePass123"
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
    const created = await users.create(superAdminUser(), "erin", "user");
    const login = await auth.login("erin", created.temporaryPassword);

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

  it("prevents ordinary admins from managing admin and super admin accounts", async () => {
    const { auth, passwordHasher, prisma, users } = makeServices();
    await seedSuperAdmin(passwordHasher, prisma);
    const manager = await users.create(superAdminUser(), "ops_admin", "admin");
    const root = await auth.login("admin", "AdminInitPass1");

    await expect(
      users.resetPassword(manager.user.id, adminUser())
    ).rejects.toThrow("普通管理员不能管理管理员账号");
    await expect(
      users.resetPassword(root.user.id, superAdminUser())
    ).rejects.toThrow("超级管理员只能通过本人账号或服务器脚本管理");
  });

  it("uses the same password rules for super admin password changes", async () => {
    const { auth, passwordHasher, prisma } = makeServices();

    await seedSuperAdmin(passwordHasher, prisma);
    const login = await auth.login("admin", "AdminInitPass1");

    await expect(
      auth.changePassword(login.user.id, "AdminInitPass1", "12345678")
    ).rejects.toThrow("密码需要同时包含字母和数字");
    await expect(
      auth.changePassword(login.user.id, "AdminInitPass1", "abcdefgh")
    ).rejects.toThrow("密码需要同时包含字母和数字");

    await expect(
      auth.changePassword(login.user.id, "AdminInitPass1", NEXT_ADMIN_PASSWORD)
    ).resolves.toMatchObject({
      user: { mustChangePassword: false, passwordKind: "user_set" },
    });
  });

  it("uses the real admin user for dev auth disabled only in development", async () => {
    const { guard, prisma, systemInitialization } = makeServices();

    process.env.NODE_ENV = "development";
    process.env.AGEWORK_DEV_AUTH_DISABLED = "true";

    await systemInitialization.onApplicationBootstrap();
    const context = contextWithoutToken();
    await expect(guard.canActivate(context)).resolves.toBe(true);
    const admin = prisma.getUser("admin");
    expect(admin).toMatchObject({
      username: "admin",
      role: "super_admin",
      status: "active",
    });
    expect(context.request.user).toMatchObject({
      userId: admin?.id,
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
