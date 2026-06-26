vi.mock("../prisma/prisma.service", () => ({
  PrismaService: class PrismaService {},
}));

import { UserService } from "./user.service";
import type { AuthService } from "../auth/auth.service";
import type { JwtUser } from "../auth/current-user.decorator";

function makeUser(overrides?: Partial<Record<string, unknown>>) {
  return {
    id: "user-1",
    username: "testuser",
    nickname: null,
    role: "user",
    status: "active",
    mustChangePassword: false,
    passwordKind: "user_set",
    passwordExpiresAt: null,
    approvedAt: new Date(),
    approvedById: null,
    lastLoginAt: null,
    createdAt: new Date(),
    ...overrides,
  };
}

function makeService(overrides?: {
  prisma?: Record<string, unknown>;
  auth?: Partial<AuthService>;
}) {
  const prisma = {
    user: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue(makeUser()),
      update: vi.fn().mockResolvedValue(makeUser()),
      count: vi.fn().mockResolvedValue(0),
    },
    ...overrides?.prisma,
  };
  const auth: Partial<AuthService> = {
    hashPassword: vi.fn().mockResolvedValue("hashed"),
    ...overrides?.auth,
  };
  const events = { emit: vi.fn() };
  return {
    service: new UserService(
      prisma as never,
      auth as AuthService,
      events as never
    ),
    prisma,
    auth,
    events,
  };
}

const superAdmin: JwtUser = {
  userId: "sa-1",
  username: "admin",
  role: "super_admin",
  status: "active",
  mustChangePassword: false,
  sessionVersion: 1,
};

const admin: JwtUser = {
  userId: "adm-1",
  username: "manager",
  role: "admin",
  status: "active",
  mustChangePassword: false,
  sessionVersion: 1,
};

describe("UserService", () => {
  describe("list()", () => {
    it("returns all non-deleted users for super_admin", async () => {
      const { service, prisma } = makeService();
      prisma.user.findMany.mockResolvedValue([
        makeUser(),
        makeUser({ id: "user-2" }),
      ]);

      const result = await service.list(superAdmin);

      expect(prisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { deletedAt: null } })
      );
      expect(result.list).toHaveLength(2);
    });

    it("filters to role=user for non-super_admin operators", async () => {
      const { service, prisma } = makeService();
      prisma.user.findMany.mockResolvedValue([makeUser()]);

      await service.list(admin);

      expect(prisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { deletedAt: null, role: "user" } })
      );
    });

    it("returns paginated results when pagination is provided", async () => {
      const { service, prisma } = makeService();
      prisma.user.findMany.mockResolvedValue([makeUser()]);
      prisma.user.count.mockResolvedValue(10);

      const result = await service.list(superAdmin, { take: 5, skip: 5 });

      expect(result).toMatchObject({ total: 10, pageNo: 2, pageSize: 5 });
    });
  });

  describe("create()", () => {
    it("creates a user with temporary password", async () => {
      const { service, prisma } = makeService();
      prisma.user.findFirst.mockResolvedValue(null);
      prisma.user.create.mockResolvedValue(makeUser({ id: "new-1" }));

      const result = await service.create(superAdmin, "newuser", "user");

      expect(result.temporaryPassword).toEqual(expect.any(String));
      expect(prisma.user.create).toHaveBeenCalled();
    });

    it("rejects creating super_admin role", async () => {
      const { service } = makeService();
      await expect(
        service.create(superAdmin, "evil", "super_admin")
      ).rejects.toThrow("不能创建超级管理员");
    });

    it("prevents regular admin from creating admin users", async () => {
      const { service } = makeService();
      await expect(service.create(admin, "someone", "admin")).rejects.toThrow(
        "普通管理员只能创建普通用户"
      );
    });

    it("rejects duplicate username", async () => {
      const { service, prisma } = makeService();
      prisma.user.findFirst.mockResolvedValue(makeUser());

      await expect(service.create(superAdmin, "existing")).rejects.toThrow(
        "用户名 existing 已存在"
      );
    });
  });

  describe("approve()", () => {
    it("approves a pending user", async () => {
      const { service, prisma } = makeService();
      prisma.user.findFirst.mockResolvedValue(
        makeUser({ status: "pending", role: "user" })
      );
      prisma.user.update.mockResolvedValue(makeUser({ status: "active" }));

      const result = await service.approve("user-1", superAdmin);

      expect(result.status).toBe("active");
    });

    it("rejects approving non-user roles", async () => {
      const { service, prisma } = makeService();
      prisma.user.findFirst.mockResolvedValue(makeUser({ role: "admin" }));

      await expect(service.approve("user-1", superAdmin)).rejects.toThrow(
        "只能审批普通用户注册"
      );
    });

    it("rejects approving non-pending users", async () => {
      const { service, prisma } = makeService();
      prisma.user.findFirst.mockResolvedValue(
        makeUser({ status: "active", role: "user" })
      );

      await expect(service.approve("user-1", superAdmin)).rejects.toThrow(
        "用户不是待审批状态"
      );
    });
  });

  describe("update()", () => {
    it("updates user role", async () => {
      const { service, prisma } = makeService();
      prisma.user.findFirst.mockResolvedValue(makeUser());
      prisma.user.update.mockResolvedValue(makeUser({ role: "admin" }));

      const result = await service.update(
        "user-1",
        { role: "admin" },
        superAdmin
      );

      expect(result.role).toBe("admin");
    });

    it("rejects role change by non-super_admin", async () => {
      const { service, prisma } = makeService();
      prisma.user.findFirst.mockResolvedValue(makeUser());

      await expect(
        service.update("user-1", { role: "admin" }, admin)
      ).rejects.toThrow("普通管理员不能调整角色");
    });

    it("rejects setting super_admin role", async () => {
      const { service, prisma } = makeService();
      prisma.user.findFirst.mockResolvedValue(makeUser());

      await expect(
        service.update("user-1", { role: "super_admin" }, superAdmin)
      ).rejects.toThrow("不能设置超级管理员角色");
    });

    it("rejects setting status to pending", async () => {
      const { service, prisma } = makeService();
      prisma.user.findFirst.mockResolvedValue(makeUser());

      await expect(
        service.update("user-1", { status: "pending" }, superAdmin)
      ).rejects.toThrow("不能通过更新接口设为待审批");
    });

    it("emits USER_DISABLED_EVENT when disabling a user", async () => {
      const { service, prisma, events } = makeService();
      prisma.user.findFirst.mockResolvedValue(makeUser());
      prisma.user.update.mockResolvedValue(makeUser({ status: "disabled" }));

      await service.update("user-1", { status: "disabled" }, superAdmin);

      expect(events.emit).toHaveBeenCalledWith(
        "user.disabled",
        expect.objectContaining({ userId: "user-1" })
      );
    });
  });

  describe("resetPassword()", () => {
    it("resets password and returns temporary password", async () => {
      const { service, prisma } = makeService();
      prisma.user.findFirst.mockResolvedValue(makeUser());
      prisma.user.update.mockResolvedValue(
        makeUser({ mustChangePassword: true, passwordKind: "temporary" })
      );

      const result = await service.resetPassword("user-1", superAdmin);

      expect(result.temporaryPassword).toEqual(expect.any(String));
      expect(result.user.mustChangePassword).toBe(true);
    });

    it("prevents regular admin from resetting admin passwords", async () => {
      const { service, prisma } = makeService();
      prisma.user.findFirst.mockResolvedValue(makeUser({ role: "admin" }));

      await expect(service.resetPassword("user-1", admin)).rejects.toThrow(
        "普通管理员不能管理管理员账号"
      );
    });
  });

  describe("delete()", () => {
    it("soft-deletes a regular user and emits event", async () => {
      const { service, prisma, events } = makeService();
      prisma.user.findFirst.mockResolvedValue(makeUser());

      await service.delete("user-1", superAdmin);

      const updateCall = prisma.user.update.mock.calls[0]?.[0] as {
        where: { id: string };
        data: { deletedAt: Date };
      };
      expect(updateCall.where).toEqual({ id: "user-1" });
      expect(updateCall.data.deletedAt).toBeInstanceOf(Date);
      expect(events.emit).toHaveBeenCalledWith(
        "user.deleted",
        expect.objectContaining({ userId: "user-1" })
      );
    });

    it("prevents self-deletion", async () => {
      const { service, prisma } = makeService();
      prisma.user.findFirst.mockResolvedValue(makeUser());

      await expect(
        service.delete(superAdmin.userId, superAdmin)
      ).rejects.toThrow("不能删除自己");
    });

    it("prevents deleting admin accounts", async () => {
      const { service, prisma } = makeService();
      prisma.user.findFirst.mockResolvedValue(makeUser({ role: "admin" }));

      await expect(service.delete("user-1", superAdmin)).rejects.toThrow(
        "管理员账号不能删除，只能停用"
      );
    });
  });
});
