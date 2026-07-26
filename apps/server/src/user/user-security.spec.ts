import { UserService } from "./user.service";
import { UserRepository } from "./user.repository";
import { PasswordHasherService } from "./credential/password-hasher.service";
import { SUPER_ADMIN_USERNAME } from "./credential/user-credential";
import { LoginFailedException } from "./credential/login-failed.exception";
import type { JwtUser } from "../auth/auth.types";
import type { PrismaService } from "../prisma/prisma.service";

const INITIAL_PASSWORD_TTL_MS = 72 * 60 * 60 * 1000;
const RESET_PASSWORD_TTL_MS = 24 * 60 * 60 * 1000;

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

/**
 * 内存版 Prisma 替身：真实驱动 UserRepository + PasswordHasherService，
 * 用于验证 UserService 完整的账号安全业务规则（不涉及 auth/system 模块）。
 */
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
      const username = requiredString(args.data.username, "username");
      if (this.users.some((candidate) => candidate.username === username)) {
        // 模拟 Prisma 唯一约束冲突，驱动并发抢注的 P2002 处理路径
        throw Object.assign(
          new Error("Unique constraint failed on the fields: (`username`)"),
          { code: "P2002" }
        );
      }
      const now = new Date();
      const user: TestUser = {
        id:
          typeof args.data.id === "string"
            ? args.data.id
            : `user-${this.nextId++}`,
        username,
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
  const passwordHasher = new PasswordHasherService();
  const repository = new UserRepository(prisma as unknown as PrismaService);
  const users = new UserService(
    repository,
    passwordHasher,
    {
      emit: vi.fn(),
    } as never,
    {
      listLifecycleClaims: vi.fn().mockResolvedValue([]),
      listConnectedHostIds: vi.fn().mockReturnValue([]),
      releaseResources: vi.fn().mockResolvedValue(undefined),
    } as never
  );

  return { users, repository, passwordHasher, prisma };
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

describe("user account security flows", () => {
  it("ensureDevSuperAdmin creates the fixed admin super admin without exposing a password", async () => {
    const { users, prisma } = makeServices();

    await users.ensureDevSuperAdmin();

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
    const { users, prisma } = makeServices();

    await expect(users.isNoSuperAdmin()).resolves.toBe(true);
    expect(prisma.getUser("admin")).toBeUndefined();

    const admin = await users.setupSuperAdmin("AdminInitPass1");

    expect(admin).toMatchObject({
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
    await expect(users.isNoSuperAdmin()).resolves.toBe(false);
    await expect(users.setupSuperAdmin("AdminInitPass2")).rejects.toThrow(
      "系统已初始化"
    );
  });

  it("converts a concurrent super-admin creation race into 系统已初始化", async () => {
    const { users } = makeServices();
    // 模拟两个请求都通过 isNoSuperAdmin 后，另一个先一步落库（P2002 -> null）
    vi.spyOn(
      UserRepository.prototype,
      "createSuperAdmin"
    ).mockResolvedValueOnce(null);
    await expect(users.setupSuperAdmin("AdminInitPass1")).rejects.toThrow(
      "系统已初始化"
    );
  });

  it("createSuperAdmin returns null instead of throwing on a unique-constraint collision", async () => {
    const { prisma } = makeServices();
    const repo = new UserRepository(prisma as unknown as PrismaService);
    const data = {
      id: "race-1",
      username: SUPER_ADMIN_USERNAME,
      passwordHash: "hash",
      role: "super_admin",
      status: "active",
      mustChangePassword: false,
      passwordKind: "user_set",
    };

    await expect(repo.createSuperAdmin(data)).resolves.toMatchObject({
      username: SUPER_ADMIN_USERNAME,
    });
    await expect(
      repo.createSuperAdmin({ ...data, id: "race-2" })
    ).resolves.toBeNull();
  });

  it("validates usernames and passwords before registration", async () => {
    const { users } = makeServices();

    await expect(users.register("ab", "UserPass123")).rejects.toThrow(
      "用户名至少需要"
    );
    await expect(users.register("valid_user", "short")).rejects.toThrow(
      "密码至少需要"
    );
    await expect(users.register("numbers", "12345678")).rejects.toThrow(
      "密码需要同时包含字母和数字"
    );
    await expect(users.register("letters", "abcdefgh")).rejects.toThrow(
      "密码需要同时包含字母和数字"
    );
    await expect(users.register("SameName1", "SameName1")).rejects.toThrow(
      "密码不能和用户名相同"
    );
    await expect(
      users.register("common_user", "password1")
    ).resolves.toMatchObject({
      username: "common_user",
      status: "pending",
    });
  });

  it("keeps self-registered users pending without forcing password changes after approval", async () => {
    const { users } = makeServices();

    const registered = await users.register("alice", "AlicePass123");
    expect(registered).toMatchObject({
      role: "user",
      status: "pending",
      mustChangePassword: false,
      passwordKind: "user_set",
    });
    await expect(users.authenticate("alice", "AlicePass123")).rejects.toThrow(
      "用户名或密码错误"
    );

    await users.approve(registered.id, superAdminUser());

    const login = await users.authenticate("alice", "AlicePass123");
    expect(login).toMatchObject({
      status: "active",
      mustChangePassword: false,
    });
  });

  it("returns one generic error for non-existent, wrong-password, pending, and disabled logins while keeping the internal reason", async () => {
    const { users } = makeServices();

    const active = await users.create(superAdminUser(), "active_user", "user");
    const disabled = await users.create(
      superAdminUser(),
      "disabled_user",
      "user"
    );
    await users.update(
      disabled.user.id,
      { status: "disabled" },
      superAdminUser()
    );
    await users.register("pending_user", "PendingPass123");

    const attempts: Array<{
      username: string;
      password: string;
      reason: string;
    }> = [
      {
        username: "ghost_user",
        password: "Whatever123",
        reason: "user_not_found",
      },
      {
        username: "active_user",
        password: "WrongPass999",
        reason: "bad_password",
      },
      {
        username: "pending_user",
        password: "PendingPass123",
        reason: "pending",
      },
      {
        username: "disabled_user",
        password: disabled.temporaryPassword,
        reason: "disabled",
      },
    ];

    const errors: LoginFailedException[] = [];
    for (const attempt of attempts) {
      await users
        .authenticate(attempt.username, attempt.password)
        .catch((error) => errors.push(error));
    }

    // 对外：所有失败都是同一句话，区分不出账号是否存在 / 状态
    expect(new Set(errors.map((error) => error.message))).toEqual(
      new Set(["用户名或密码错误"])
    );
    // 对内：保留具体原因供审计
    expect(errors.every((error) => error instanceof LoginFailedException)).toBe(
      true
    );
    expect(errors.map((error) => error.reason)).toEqual(
      attempts.map((attempt) => attempt.reason)
    );

    // 正确密码的活跃账号仍可登录，确认收敛没有误伤正常路径
    await expect(
      users.authenticate("active_user", active.temporaryPassword)
    ).resolves.toMatchObject({ username: "active_user" });
  });

  it("generates 72-hour initial passwords for admin-created accounts", async () => {
    const { users } = makeServices();
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

    const login = await users.authenticate(
      "manager",
      created.temporaryPassword
    );
    expect(login.mustChangePassword).toBe(true);
  });

  it("rejects expired initial or temporary passwords during login", async () => {
    const { users, prisma } = makeServices();
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
      users.authenticate("expired_user", created.temporaryPassword)
    ).rejects.toThrow("用户名或密码错误");
  });

  it("creates 24-hour temporary passwords during admin reset and invalidates the old password", async () => {
    const { users } = makeServices();
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
    await expect(
      users.authenticate("bob", created.temporaryPassword)
    ).rejects.toThrow("用户名或密码错误");

    const login = await users.authenticate("bob", reset.temporaryPassword);
    expect(login.mustChangePassword).toBe(true);
  });

  it("clears temporary password state and increments sessionVersion after forced password change", async () => {
    const { users } = makeServices();
    const created = await users.create(superAdminUser(), "carol", "user");
    const login = await users.authenticate("carol", created.temporaryPassword);

    const changed = await users.completePasswordChange(
      created.user.id,
      "CarolPass123"
    );

    expect(login.sessionVersion).toBe(1);
    expect(changed).toMatchObject({
      mustChangePassword: false,
      passwordKind: "user_set",
      passwordExpiresAt: null,
      sessionVersion: 2,
    });
    await expect(
      users.authenticate("carol", created.temporaryPassword)
    ).rejects.toThrow("用户名或密码错误");
    await expect(
      users.authenticate("carol", "CarolPass123")
    ).resolves.toMatchObject({ mustChangePassword: false });
  });

  it("rejects forced password changes when the account does not require one", async () => {
    const { users } = makeServices();

    const created = await users.create(superAdminUser(), "ready_user", "user");
    const changed = await users.completePasswordChange(
      created.user.id,
      "ReadyPass123"
    );

    await expect(
      users.completePasswordChange(changed.id, "ReadyPass456")
    ).rejects.toThrow("当前账号不需要强制修改密码");
  });

  it("prevents ordinary admins from managing admin and super admin accounts", async () => {
    const { users, passwordHasher, prisma } = makeServices();
    await seedSuperAdmin(passwordHasher, prisma);
    const manager = await users.create(superAdminUser(), "ops_admin", "admin");
    const root = await users.authenticate("admin", "AdminInitPass1");

    await expect(
      users.resetPassword(manager.user.id, adminUser())
    ).rejects.toThrow("普通管理员不能管理管理员账号");
    await expect(
      users.resetPassword(root.id, superAdminUser())
    ).rejects.toThrow("超级管理员只能通过本人账号或服务器脚本管理");
  });

  it("uses the same password rules for super admin password changes", async () => {
    const { users, passwordHasher, prisma } = makeServices();

    await seedSuperAdmin(passwordHasher, prisma);
    const login = await users.authenticate("admin", "AdminInitPass1");

    await expect(
      users.changePassword(login.id, "AdminInitPass1", "12345678")
    ).rejects.toThrow("密码需要同时包含字母和数字");
    await expect(
      users.changePassword(login.id, "AdminInitPass1", "abcdefgh")
    ).rejects.toThrow("密码需要同时包含字母和数字");

    await expect(
      users.changePassword(login.id, "AdminInitPass1", "Next2026x")
    ).resolves.toMatchObject({
      mustChangePassword: false,
      passwordKind: "user_set",
    });
  });
});
