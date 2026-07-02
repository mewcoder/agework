import { Injectable } from "@nestjs/common";
import { generateId } from "@agework/shared";
import { PrismaService } from "../prisma/prisma.service";

export type UserRecord = {
  id: string;
  username: string;
  nickname: string | null;
  role: string;
  status: string;
  mustChangePassword: boolean;
  passwordKind: string;
  passwordExpiresAt: Date | null;
  approvedAt: Date | null;
  approvedById: string | null;
  lastLoginAt: Date | null;
  createdAt: Date;
  sessionVersion: number;
};

export type CredentialUserRecord = UserRecord & {
  passwordHash: string;
  lockedUntil: Date | null;
  failedLoginCount: number;
};

export type UserSessionRecord = {
  id: string;
  username: string;
  role: string;
  status: string;
  mustChangePassword: boolean;
  sessionVersion: number;
};

export type SuperAdminIdentity = {
  id: string;
  username: string;
};

export type UserCreateData = {
  id: string;
  username: string;
  passwordHash: string;
  role: string;
  status: string;
  mustChangePassword: boolean;
  passwordKind: string;
  passwordExpiresAt?: Date | null;
  passwordUpdatedAt?: Date;
  approvedAt?: Date;
  approvedById?: string;
  passwordResetAt?: Date;
  passwordResetById?: string;
};

export type ProfilePatch = {
  role?: string;
  status?: string;
};

export type PasswordSetData = {
  passwordHash: string;
  passwordUpdatedAt: Date;
};

export type PasswordResetData = {
  passwordHash: string;
  passwordExpiresAt: Date;
  passwordResetAt: Date;
  passwordResetById: string;
  passwordUpdatedAt: Date;
};

export type DevSuperAdminData = {
  passwordHash: string;
  passwordUpdatedAt: Date;
  approvedAt: Date;
};

/**
 * User 领域持久化边界：封装 Prisma 访问与字段安全 select，敏感字段
 * (passwordHash / failedLoginCount / lockedUntil) 只在凭据查询路径暴露。
 */
@Injectable()
export class UserRepository {
  constructor(private prisma: PrismaService) {}

  async list(opts: {
    includeAllRoles: boolean;
    take?: number;
    skip?: number;
  }): Promise<{ list: UserRecord[]; total: number }> {
    const where = {
      deletedAt: null,
      ...(opts.includeAllRoles ? {} : { role: "user" }),
    };
    if (opts.take !== undefined && opts.skip !== undefined) {
      const [list, total] = await Promise.all([
        this.prisma.user.findMany({
          where,
          orderBy: { createdAt: "asc" },
          select: this.userSelect(),
          take: opts.take,
          skip: opts.skip,
        }),
        this.prisma.user.count({ where }),
      ]);
      return { list, total };
    }
    const list = await this.prisma.user.findMany({
      where,
      orderBy: { createdAt: "asc" },
      select: this.userSelect(),
    });
    return { list, total: list.length };
  }

  findById(id: string): Promise<UserRecord | null> {
    return this.prisma.user.findFirst({
      where: { id, deletedAt: null },
      select: this.userSelect(),
    });
  }

  findIdByUsername(username: string): Promise<{ id: string } | null> {
    return this.prisma.user.findFirst({
      where: { username },
      select: { id: true },
    });
  }

  findCredentialByUsername(
    username: string
  ): Promise<CredentialUserRecord | null> {
    return this.prisma.user.findFirst({
      where: { username, deletedAt: null },
      select: this.credentialSelect(),
    });
  }

  findCredentialByIdActive(id: string): Promise<CredentialUserRecord | null> {
    return this.prisma.user.findFirst({
      where: { id, status: "active", deletedAt: null },
      select: this.credentialSelect(),
    });
  }

  findSessionUserById(id: string): Promise<UserSessionRecord | null> {
    return this.prisma.user.findFirst({
      where: { id, status: "active", deletedAt: null },
      select: this.sessionSelect(),
    });
  }

  findDevSuperAdminSessionUser(
    username: string
  ): Promise<UserSessionRecord | null> {
    return this.prisma.user.findFirst({
      where: {
        username,
        role: "super_admin",
        status: "active",
        deletedAt: null,
      },
      select: this.sessionSelect(),
    });
  }

  findSuperAdmins(): Promise<SuperAdminIdentity[]> {
    return this.prisma.user.findMany({
      where: { role: "super_admin", deletedAt: null },
      select: { id: true, username: true },
    });
  }

  findSuperAdminByUsername(
    username: string
  ): Promise<{ id: string; deletedAt: Date | null } | null> {
    return this.prisma.user.findUnique({
      where: { username },
      select: { id: true, deletedAt: true },
    });
  }

  create(data: UserCreateData): Promise<UserRecord> {
    return this.prisma.user.create({
      data,
      select: this.userSelect(),
    });
  }

  /**
   * 创建超级管理员；并发场景下若 username 唯一约束被他人抢先占用（P2002），
   * 返回 null 表示"已被初始化"，由调用方收敛为业务错误而非 500。
   */
  async createSuperAdmin(data: UserCreateData): Promise<UserRecord | null> {
    try {
      return await this.prisma.user.create({
        data,
        select: this.userSelect(),
      });
    } catch (error) {
      if ((error as { code?: string })?.code === "P2002") return null;
      throw error;
    }
  }

  approve(
    id: string,
    approvedAt: Date,
    approvedById: string
  ): Promise<UserRecord> {
    return this.prisma.user.update({
      where: { id },
      data: {
        status: "active",
        approvedAt,
        approvedById,
        sessionVersion: { increment: 1 },
      },
      select: this.userSelect(),
    });
  }

  updateProfile(id: string, patch: ProfilePatch): Promise<UserRecord> {
    const data: Record<string, unknown> = {};
    if (patch.role !== undefined) data.role = patch.role;
    if (patch.status !== undefined) data.status = patch.status;
    if (patch.role !== undefined || patch.status !== undefined) {
      data.sessionVersion = { increment: 1 };
    }
    return this.prisma.user.update({
      where: { id },
      data,
      select: this.userSelect(),
    });
  }

  resetPassword(id: string, data: PasswordResetData): Promise<UserRecord> {
    return this.prisma.user.update({
      where: { id },
      data: {
        passwordHash: data.passwordHash,
        passwordKind: "temporary",
        passwordExpiresAt: data.passwordExpiresAt,
        passwordResetAt: data.passwordResetAt,
        passwordResetById: data.passwordResetById,
        passwordUpdatedAt: data.passwordUpdatedAt,
        mustChangePassword: true,
        failedLoginCount: 0,
        lockedUntil: null,
        sessionVersion: { increment: 1 },
      },
      select: this.userSelect(),
    });
  }

  setPassword(id: string, data: PasswordSetData): Promise<UserRecord> {
    return this.prisma.user.update({
      where: { id },
      data: {
        passwordHash: data.passwordHash,
        passwordKind: "user_set",
        passwordExpiresAt: null,
        passwordUpdatedAt: data.passwordUpdatedAt,
        mustChangePassword: false,
        failedLoginCount: 0,
        lockedUntil: null,
        sessionVersion: { increment: 1 },
      },
      select: this.userSelect(),
    });
  }

  async recordFailedLogin(
    id: string,
    nextCount: number,
    lockedUntil: Date | null
  ): Promise<void> {
    await this.prisma.user.update({
      where: { id },
      data: { failedLoginCount: nextCount, lockedUntil },
    });
  }

  recordSuccessfulLogin(id: string, lastLoginAt: Date): Promise<UserRecord> {
    return this.prisma.user.update({
      where: { id },
      data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt },
      select: this.userSelect(),
    });
  }

  async softDelete(id: string): Promise<void> {
    await this.prisma.user.update({
      where: { id },
      data: { deletedAt: new Date(), sessionVersion: { increment: 1 } },
    });
  }

  async syncDevSuperAdmin(
    username: string,
    data: DevSuperAdminData,
    existing: { id: string } | null
  ): Promise<void> {
    const payload = {
      passwordHash: data.passwordHash,
      role: "super_admin",
      status: "active",
      mustChangePassword: false,
      passwordKind: "dev_auth_disabled",
      passwordExpiresAt: null,
      passwordUpdatedAt: data.passwordUpdatedAt,
      approvedAt: data.approvedAt,
      failedLoginCount: 0,
      lockedUntil: null,
    };
    if (existing) {
      await this.prisma.user.update({
        where: { id: existing.id },
        data: { ...payload, sessionVersion: { increment: 1 } },
      });
      return;
    }
    await this.prisma.user.create({
      data: { id: generateId(), username, ...payload },
    });
  }

  private userSelect() {
    return {
      id: true,
      username: true,
      nickname: true,
      role: true,
      status: true,
      mustChangePassword: true,
      passwordKind: true,
      passwordExpiresAt: true,
      approvedAt: true,
      approvedById: true,
      lastLoginAt: true,
      createdAt: true,
      sessionVersion: true,
    } as const;
  }

  private credentialSelect() {
    return {
      ...this.userSelect(),
      passwordHash: true,
      failedLoginCount: true,
      lockedUntil: true,
    } as const;
  }

  private sessionSelect() {
    return {
      id: true,
      username: true,
      role: true,
      status: true,
      mustChangePassword: true,
      sessionVersion: true,
    } as const;
  }
}
