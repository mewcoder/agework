import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { generateId } from "@agework/shared";
import type { UserRole } from "@agework/shared/api";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { PrismaService } from "../prisma/prisma.service";
import type { UserSession } from "./user-session";
import {
  assertPasswordForLogin,
  assertPasswordForSet,
  assertSuperAdminPasswordForSet,
  generateTemporaryPassword,
  normalizeRole,
  normalizeStatus,
  normalizeUsername,
  SUPER_ADMIN_USERNAME,
} from "./user-credentials";
import {
  USER_DELETED_EVENT,
  USER_DISABLED_EVENT,
  UserDeletedEvent,
  UserDisabledEvent,
} from "./user.events";
import { PasswordHasherService } from "./password-hasher.service";

const INITIAL_PASSWORD_TTL_MS = 72 * 60 * 60 * 1000;
const RESET_PASSWORD_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_FAILED_LOGIN_COUNT = 5;
const LOGIN_LOCK_MS = 15 * 60 * 1000;
const SUPER_ADMIN_MAX_FAILED_LOGIN_COUNT = 3;
const SUPER_ADMIN_LOGIN_LOCK_MS = 30 * 60 * 1000;

type UserRecord = {
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

type CredentialUserRecord = UserRecord & {
  passwordHash: string;
  lockedUntil: Date | null;
  failedLoginCount: number;
};

type SuperAdminIdentity = {
  id: string;
  username: string;
};

@Injectable()
export class UserService {
  constructor(
    private prisma: PrismaService,
    private passwordHasher: PasswordHasherService,
    private events: EventEmitter2
  ) {}

  async list(operator: UserSession, pagination?: { take: number; skip: number }) {
    const where = {
      deletedAt: null,
      ...(operator.role === "super_admin" ? {} : { role: "user" }),
    };
    if (pagination) {
      const [users, total] = await Promise.all([
        this.prisma.user.findMany({
          where,
          orderBy: { createdAt: "asc" },
          select: this.userSelect(),
          take: pagination.take,
          skip: pagination.skip,
        }),
        this.prisma.user.count({ where }),
      ]);
      return {
        list: users.map((user) => this.toUserDto(user)),
        total,
        pageNo: pagination.skip / pagination.take + 1,
        pageSize: pagination.take,
      };
    }
    const users = await this.prisma.user.findMany({
      where,
      orderBy: { createdAt: "asc" },
      select: this.userSelect(),
    });
    return { list: users.map((user) => this.toUserDto(user)) };
  }

  async create(operator: UserSession, username: string, role = "user") {
    const normalizedUsername = normalizeUsername(username);
    const targetRole = normalizeRole(role);
    if (targetRole === "super_admin") {
      throw new BadRequestException("不能创建超级管理员");
    }
    if (operator.role !== "super_admin" && targetRole !== "user") {
      throw new ForbiddenException("普通管理员只能创建普通用户");
    }

    const existing = await this.prisma.user.findFirst({
      where: { username: normalizedUsername },
    });
    if (existing) {
      throw new BadRequestException(`用户名 ${normalizedUsername} 已存在`);
    }

    const temporaryPassword = generateTemporaryPassword();
    const now = new Date();
    const passwordExpiresAt = new Date(now.getTime() + INITIAL_PASSWORD_TTL_MS);
    const id = generateId();
    const user = await this.prisma.user.create({
      data: {
        id,
        username: normalizedUsername,
        passwordHash: await this.passwordHasher.hash(temporaryPassword),
        role: targetRole,
        status: "active",
        mustChangePassword: true,
        passwordKind: "initial",
        passwordExpiresAt,
        passwordUpdatedAt: now,
        approvedAt: now,
        approvedById: this.operatorId(operator),
      },
      select: this.userSelect(),
    });
    return {
      user: this.toUserDto(user),
      temporaryPassword,
      passwordExpiresAt: passwordExpiresAt.toISOString(),
    };
  }

  async approve(id: string, operator: UserSession) {
    const user = await this.getUserOrThrow(id);
    this.assertCanManage(operator, user, "approve");
    if (user.role !== "user") {
      throw new BadRequestException("只能审批普通用户注册");
    }
    if (user.status !== "pending") {
      throw new BadRequestException("用户不是待审批状态");
    }

    const updated = await this.prisma.user.update({
      where: { id },
      data: {
        status: "active",
        approvedAt: new Date(),
        approvedById: this.operatorId(operator),
        sessionVersion: { increment: 1 },
      },
      select: this.userSelect(),
    });
    return this.toUserDto(updated);
  }

  async update(
    id: string,
    data: { role?: string; status?: string },
    operator: UserSession
  ) {
    const user = await this.getUserOrThrow(id);
    this.assertCanManage(operator, user, "update");

    const updateData: Record<string, unknown> = {};
    if (data.role !== undefined) {
      if (operator.role !== "super_admin") {
        throw new ForbiddenException("普通管理员不能调整角色");
      }
      const role = normalizeRole(data.role);
      if (role === "super_admin") {
        throw new BadRequestException("不能设置超级管理员角色");
      }
      updateData.role = role;
      updateData.sessionVersion = { increment: 1 };
    }
    if (data.status !== undefined) {
      const status = normalizeStatus(data.status);
      if (status === "pending") {
        throw new BadRequestException("不能通过更新接口设为待审批");
      }
      updateData.status = status;
      updateData.sessionVersion = { increment: 1 };
    }

    const updated = await this.prisma.user.update({
      where: { id },
      data: updateData,
      select: this.userSelect(),
    });

    if (
      data.status !== undefined &&
      normalizeStatus(data.status) === "disabled"
    ) {
      this.events.emit(USER_DISABLED_EVENT, new UserDisabledEvent(id));
    }

    return this.toUserDto(updated);
  }

  async resetPassword(id: string, operator: UserSession) {
    const user = await this.getUserOrThrow(id);
    this.assertCanManage(operator, user, "reset-password");

    const temporaryPassword = generateTemporaryPassword();
    const now = new Date();
    const passwordExpiresAt = new Date(now.getTime() + RESET_PASSWORD_TTL_MS);
    const updated = await this.prisma.user.update({
      where: { id },
      data: {
        passwordHash: await this.passwordHasher.hash(temporaryPassword),
        passwordKind: "temporary",
        passwordExpiresAt,
        passwordResetAt: now,
        passwordResetById: this.operatorId(operator),
        passwordUpdatedAt: now,
        mustChangePassword: true,
        failedLoginCount: 0,
        lockedUntil: null,
        sessionVersion: { increment: 1 },
      },
      select: this.userSelect(),
    });
    return {
      user: this.toUserDto(updated),
      temporaryPassword,
      passwordExpiresAt: passwordExpiresAt.toISOString(),
    };
  }

  async delete(id: string, operator: UserSession) {
    const user = await this.getUserOrThrow(id);
    if (id === operator.userId) {
      throw new BadRequestException("不能删除自己");
    }
    this.assertCanManage(operator, user, "delete");
    if (user.role !== "user") {
      throw new BadRequestException("管理员账号不能删除，只能停用");
    }

    await this.prisma.user.update({
      where: { id },
      data: {
        deletedAt: new Date(),
        sessionVersion: { increment: 1 },
      },
    });

    this.events.emit(USER_DELETED_EVENT, new UserDeletedEvent(id));
  }

  async isSetupRequired(): Promise<boolean> {
    const superAdmins = await this.prisma.user.findMany({
      where: { role: "super_admin", deletedAt: null },
      select: { id: true, username: true },
    });

    this.assertSingleFixedSuperAdmin(superAdmins);
    return superAdmins.length === 0;
  }

  async setupSuperAdmin(newPassword: string) {
    if (!(await this.isSetupRequired())) {
      throw new BadRequestException("系统已初始化");
    }

    const existing = await this.prisma.user.findUnique({
      where: { username: SUPER_ADMIN_USERNAME },
      select: { id: true, deletedAt: true },
    });
    if (existing) {
      throw new BadRequestException(
        existing.deletedAt
          ? "管理员用户名已被软删除账号占用，请先清理数据库"
          : "管理员用户名已被占用"
      );
    }

    const password = assertSuperAdminPasswordForSet(
      newPassword,
      SUPER_ADMIN_USERNAME
    );
    const now = new Date();
    const user = await this.prisma.user.create({
      data: {
        id: generateId(),
        username: SUPER_ADMIN_USERNAME,
        passwordHash: await this.passwordHasher.hash(password),
        role: "super_admin",
        status: "active",
        mustChangePassword: false,
        passwordKind: "user_set",
        passwordExpiresAt: null,
        passwordUpdatedAt: now,
        approvedAt: now,
      },
      select: this.userSelect(),
    });

    return this.toUserDto(user);
  }

  async ensureDevSuperAdmin(): Promise<void> {
    const existing = await this.prisma.user.findUnique({
      where: { username: SUPER_ADMIN_USERNAME },
      select: { id: true, deletedAt: true },
    });

    if (existing?.deletedAt) {
      throw new Error(
        "超级管理员固定用户名 admin 已被软删除账号占用，请先清理数据库"
      );
    }

    const now = new Date();
    const data = {
      passwordHash: await this.passwordHasher.hash(randomUUID()),
      role: "super_admin",
      status: "active",
      mustChangePassword: false,
      passwordKind: "dev_auth_disabled",
      passwordExpiresAt: null,
      passwordUpdatedAt: now,
      approvedAt: now,
      failedLoginCount: 0,
      lockedUntil: null,
    };

    if (existing) {
      await this.prisma.user.update({
        where: { id: existing.id },
        data: {
          ...data,
          sessionVersion: { increment: 1 },
        },
      });
      return;
    }

    await this.prisma.user.create({
      data: {
        id: generateId(),
        username: SUPER_ADMIN_USERNAME,
        ...data,
      },
    });
  }

  async register(username: string, password: string) {
    const normalizedUsername = normalizeUsername(username);
    const rawPassword = assertPasswordForSet(password, normalizedUsername);

    const existing = await this.prisma.user.findFirst({
      where: { username: normalizedUsername },
      select: { id: true },
    });
    if (existing) {
      throw new BadRequestException("注册失败，请稍后重试");
    }

    const now = new Date();
    const id = generateId();
    const user = await this.prisma.user.create({
      data: {
        id,
        username: normalizedUsername,
        passwordHash: await this.passwordHasher.hash(rawPassword),
        role: "user",
        status: "pending",
        mustChangePassword: false,
        passwordKind: "user_set",
        passwordUpdatedAt: now,
      },
      select: this.userSelect(),
    });
    return this.toUserDto(user);
  }

  async authenticate(username: string, password: string) {
    const normalizedUsername = normalizeUsername(username);
    const rawPassword = assertPasswordForLogin(password);
    const now = new Date();

    const user = await this.prisma.user.findFirst({
      where: { username: normalizedUsername, deletedAt: null },
      select: this.credentialUserSelect(),
    });
    if (!user) {
      throw new UnauthorizedException("用户不存在");
    }

    if (user.lockedUntil && user.lockedUntil > now) {
      throw new UnauthorizedException("登录失败次数过多，请稍后再试");
    }

    const valid = await this.passwordHasher.compare(
      rawPassword,
      user.passwordHash
    );
    if (!valid) {
      await this.recordFailedLogin(user.id, user.failedLoginCount, user.role);
      throw new UnauthorizedException("用户名或密码错误");
    }

    this.assertCanLogin(user, now);

    const updated = await this.prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginCount: 0,
        lockedUntil: null,
        lastLoginAt: now,
      },
      select: this.userSelect(),
    });

    return this.toUserDto(updated);
  }

  async me(userId: string) {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: this.userSelect(),
    });
    if (!user) throw new UnauthorizedException();
    return this.toUserDto(user);
  }

  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string
  ) {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, status: "active", deletedAt: null },
      select: this.credentialUserSelect(),
    });
    if (!user) throw new UnauthorizedException();

    const current = assertPasswordForLogin(currentPassword);
    const next =
      user.role === "super_admin"
        ? assertSuperAdminPasswordForSet(newPassword, user.username)
        : assertPasswordForSet(newPassword, user.username);
    const valid = await this.passwordHasher.compare(current, user.passwordHash);
    if (!valid) throw new UnauthorizedException("当前密码错误");
    if (await this.passwordHasher.compare(next, user.passwordHash)) {
      throw new BadRequestException("新密码不能和当前密码相同");
    }

    return this.setUserPassword(user.id, next);
  }

  async completePasswordChange(userId: string, newPassword: string) {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, status: "active", deletedAt: null },
      select: this.credentialUserSelect(),
    });
    if (!user) throw new UnauthorizedException();
    if (!user.mustChangePassword) {
      throw new BadRequestException("当前账号不需要强制修改密码");
    }

    const next =
      user.role === "super_admin"
        ? assertSuperAdminPasswordForSet(newPassword, user.username)
        : assertPasswordForSet(newPassword, user.username);
    if (await this.passwordHasher.compare(next, user.passwordHash)) {
      throw new BadRequestException("新密码不能和当前密码相同");
    }

    return this.setUserPassword(user.id, next);
  }

  async findActiveSessionUser(userId: string): Promise<UserSession | null> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, status: "active", deletedAt: null },
      select: this.sessionUserSelect(),
    });
    return user ? this.toUserSession(user) : null;
  }

  async findDevSuperAdminSessionUser(): Promise<UserSession | null> {
    const user = await this.prisma.user.findFirst({
      where: {
        username: SUPER_ADMIN_USERNAME,
        role: "super_admin",
        status: "active",
        deletedAt: null,
      },
      select: this.sessionUserSelect(),
    });
    return user ? this.toUserSession(user) : null;
  }

  private async getUserOrThrow(id: string) {
    const user = await this.prisma.user.findFirst({
      where: { id, deletedAt: null },
      select: this.userSelect(),
    });
    if (!user) throw new NotFoundException(`User ${id} not found`);
    return user;
  }

  private assertCanManage(
    operator: UserSession,
    target: Pick<UserRecord, "id" | "role">,
    action: "approve" | "update" | "reset-password" | "delete"
  ) {
    if (target.role === "super_admin") {
      throw new ForbiddenException(
        "超级管理员只能通过本人账号或服务器脚本管理"
      );
    }
    if (operator.role === "super_admin") return;
    if (target.role !== "user") {
      throw new ForbiddenException("普通管理员不能管理管理员账号");
    }
    if (
      action === "delete" ||
      action === "approve" ||
      action === "update" ||
      action === "reset-password"
    ) {
      return;
    }
    throw new ForbiddenException("未授权的操作");
  }

  private assertCanLogin(user: CredentialUserRecord, now: Date) {
    if (user.status === "pending") {
      throw new UnauthorizedException("账号待管理员审批");
    }
    if (user.status === "disabled") {
      throw new UnauthorizedException("账号已停用，请联系管理员");
    }
    if (user.status !== "active") {
      throw new UnauthorizedException("账号状态异常，请联系管理员");
    }
    if (
      user.mustChangePassword &&
      user.passwordExpiresAt &&
      user.passwordExpiresAt <= now
    ) {
      throw new UnauthorizedException("临时密码已过期，请联系管理员重新生成");
    }
  }

  private async recordFailedLogin(
    userId: string,
    currentCount: number,
    role: string
  ) {
    const nextCount = currentCount + 1;
    const maxFailedLoginCount =
      role === "super_admin"
        ? SUPER_ADMIN_MAX_FAILED_LOGIN_COUNT
        : MAX_FAILED_LOGIN_COUNT;
    const loginLockMs =
      role === "super_admin" ? SUPER_ADMIN_LOGIN_LOCK_MS : LOGIN_LOCK_MS;
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        failedLoginCount: nextCount,
        lockedUntil:
          nextCount >= maxFailedLoginCount
            ? new Date(Date.now() + loginLockMs)
            : null,
      },
    });
  }

  private async setUserPassword(userId: string, next: string) {
    const now = new Date();
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: {
        passwordHash: await this.passwordHasher.hash(next),
        passwordKind: "user_set",
        passwordExpiresAt: null,
        passwordUpdatedAt: now,
        mustChangePassword: false,
        failedLoginCount: 0,
        lockedUntil: null,
        sessionVersion: { increment: 1 },
      },
      select: this.userSelect(),
    });
    return this.toUserDto(updated);
  }

  private assertSingleFixedSuperAdmin(superAdmins: SuperAdminIdentity[]) {
    if (superAdmins.length === 0) return;

    const invalidSuperAdmins = superAdmins.filter(
      (user) => user.username !== SUPER_ADMIN_USERNAME
    );
    if (invalidSuperAdmins.length > 0 || superAdmins.length > 1) {
      throw new Error(
        "超级管理员账号固定且唯一为 admin，请先清理或迁移数据库中的其他 super_admin 账号"
      );
    }
  }

  private operatorId(operator: UserSession) {
    return operator.userId;
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

  private credentialUserSelect() {
    return {
      ...this.userSelect(),
      passwordHash: true,
      failedLoginCount: true,
      lockedUntil: true,
    } as const;
  }

  private sessionUserSelect() {
    return {
      id: true,
      username: true,
      role: true,
      status: true,
      mustChangePassword: true,
      sessionVersion: true,
    } as const;
  }

  private toUserDto(user: UserRecord) {
    return {
      id: user.id,
      username: user.username,
      nickname: user.nickname,
      role: user.role as UserRole,
      status: user.status,
      mustChangePassword: user.mustChangePassword,
      passwordKind: user.passwordKind,
      passwordExpiresAt: user.passwordExpiresAt?.toISOString() ?? null,
      approvedAt: user.approvedAt?.toISOString() ?? null,
      approvedById: user.approvedById,
      lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
      createdAt: user.createdAt.toISOString(),
      sessionVersion: user.sessionVersion,
    };
  }

  private toUserSession(user: UserSessionRecord): UserSession {
    return {
      userId: user.id,
      username: user.username,
      role: user.role,
      status: user.status,
      mustChangePassword: user.mustChangePassword,
      sessionVersion: user.sessionVersion,
    };
  }
}

type UserSessionRecord = {
  id: string;
  username: string;
  role: string;
  status: string;
  mustChangePassword: boolean;
  sessionVersion: number;
};
