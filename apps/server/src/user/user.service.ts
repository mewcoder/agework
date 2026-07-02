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
import type { UserSession } from "./user.types";
import {
  assertPasswordForLogin,
  assertPasswordForSet,
  assertSuperAdminPasswordForSet,
  generateTemporaryPassword,
  normalizeRole,
  normalizeStatus,
  normalizeUsername,
  SUPER_ADMIN_USERNAME,
} from "./credential/user-credential";
import {
  USER_DELETED_EVENT,
  USER_DISABLED_EVENT,
  USER_PASSWORD_RESET_EVENT,
  UserDeletedEvent,
  UserDisabledEvent,
  UserPasswordResetEvent,
} from "./user.events";
import { PasswordHasherService } from "./credential/password-hasher.service";
import { LoginFailedException } from "./credential/login-failed.exception";
import {
  UserRepository,
  type CredentialUserRecord,
  type SuperAdminIdentity,
  type UserCreateData,
  type UserRecord,
  type UserSessionRecord,
} from "./user.repository";

const INITIAL_PASSWORD_TTL_MS = 72 * 60 * 60 * 1000;
const RESET_PASSWORD_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_FAILED_LOGIN_COUNT = 5;
const LOGIN_LOCK_MS = 15 * 60 * 1000;
const SUPER_ADMIN_MAX_FAILED_LOGIN_COUNT = 3;
const SUPER_ADMIN_LOGIN_LOCK_MS = 30 * 60 * 1000;

@Injectable()
export class UserService {
  constructor(
    private users: UserRepository,
    private passwordHasher: PasswordHasherService,
    private events: EventEmitter2
  ) {}

  /**
   * 列出用户；super_admin 可看到全部角色，普通管理员只能看到受限角色范围（由 repository 过滤）。
   * 不传 pagination 时返回全量列表。
   */
  async list(
    operator: UserSession,
    pagination?: { take: number; skip: number }
  ) {
    const { list, total } = await this.users.list({
      includeAllRoles: operator.role === "super_admin",
      take: pagination?.take,
      skip: pagination?.skip,
    });
    if (pagination) {
      return {
        list: list.map((user) => this.toUserDto(user)),
        total,
        pageNo: pagination.skip / pagination.take + 1,
        pageSize: pagination.take,
      };
    }
    return { list: list.map((user) => this.toUserDto(user)) };
  }

  /**
   * 创建用户并生成临时密码；普通管理员只能创建 user 角色，不能创建 super_admin 或其他管理员角色。
   */
  async create(operator: UserSession, username: string, role = "user") {
    const normalizedUsername = normalizeUsername(username);
    const targetRole = normalizeRole(role);
    if (targetRole === "super_admin") {
      throw new BadRequestException("不能创建超级管理员");
    }
    if (operator.role !== "super_admin" && targetRole !== "user") {
      throw new ForbiddenException("普通管理员只能创建普通用户");
    }

    const existing = await this.users.findIdByUsername(normalizedUsername);
    if (existing) {
      throw new BadRequestException(`用户名 ${normalizedUsername} 已存在`);
    }

    const temporaryPassword = generateTemporaryPassword();
    const now = new Date();
    const passwordExpiresAt = new Date(now.getTime() + INITIAL_PASSWORD_TTL_MS);
    const data: UserCreateData = {
      id: generateId(),
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
    };
    const user = await this.users.create(data);
    return {
      user: this.toUserDto(user),
      temporaryPassword,
      passwordExpiresAt: passwordExpiresAt.toISOString(),
    };
  }

  /**
   * 审批 pending 状态的 user 角色注册；super_admin 或未被禁止管理该目标用户的管理员可调用。
   */
  async approve(id: string, operator: UserSession) {
    const user = await this.getUserOrThrow(id);
    this.assertCanManage(operator, user, "approve");
    if (user.role !== "user") {
      throw new BadRequestException("只能审批普通用户注册");
    }
    if (user.status !== "pending") {
      throw new BadRequestException("用户不是待审批状态");
    }

    const updated = await this.users.approve(
      id,
      new Date(),
      this.operatorId(operator)
    );
    return this.toUserDto(updated);
  }

  /**
   * 更新用户角色/状态；角色调整仅 super_admin 可做，禁止把状态改回 pending；
   * 状态改为 disabled 时发出 USER_DISABLED_EVENT。
   */
  async update(
    id: string,
    data: { role?: string; status?: string },
    operator: UserSession
  ) {
    const user = await this.getUserOrThrow(id);
    this.assertCanManage(operator, user, "update");

    const patch: { role?: string; status?: string } = {};
    if (data.role !== undefined) {
      if (operator.role !== "super_admin") {
        throw new ForbiddenException("普通管理员不能调整角色");
      }
      const role = normalizeRole(data.role);
      if (role === "super_admin") {
        throw new BadRequestException("不能设置超级管理员角色");
      }
      patch.role = role;
    }
    if (data.status !== undefined) {
      const status = normalizeStatus(data.status);
      if (status === "pending") {
        throw new BadRequestException("不能通过更新接口设为待审批");
      }
      patch.status = status;
    }

    const updated = await this.users.updateProfile(id, patch);

    if (
      data.status !== undefined &&
      normalizeStatus(data.status) === "disabled"
    ) {
      this.events.emit(USER_DISABLED_EVENT, new UserDisabledEvent(id));
    }

    return this.toUserDto(updated);
  }

  /**
   * 管理员为目标用户重置密码为临时密码；发出 USER_PASSWORD_RESET_EVENT 通知会话失效。
   */
  async resetPassword(id: string, operator: UserSession) {
    const user = await this.getUserOrThrow(id);
    this.assertCanManage(operator, user, "reset-password");

    const temporaryPassword = generateTemporaryPassword();
    const now = new Date();
    const passwordExpiresAt = new Date(now.getTime() + RESET_PASSWORD_TTL_MS);
    const updated = await this.users.resetPassword(id, {
      passwordHash: await this.passwordHasher.hash(temporaryPassword),
      passwordExpiresAt,
      passwordResetAt: now,
      passwordResetById: this.operatorId(operator),
      passwordUpdatedAt: now,
    });
    this.events.emit(USER_PASSWORD_RESET_EVENT, new UserPasswordResetEvent(id));
    return {
      user: this.toUserDto(updated),
      temporaryPassword,
      passwordExpiresAt: passwordExpiresAt.toISOString(),
    };
  }

  /**
   * 软删除用户；不能删除自己或非 user 角色账号（管理员账号只能停用），成功后发出 USER_DELETED_EVENT。
   */
  async delete(id: string, operator: UserSession) {
    const user = await this.getUserOrThrow(id);
    if (id === operator.userId) {
      throw new BadRequestException("不能删除自己");
    }
    this.assertCanManage(operator, user, "delete");
    if (user.role !== "user") {
      throw new BadRequestException("管理员账号不能删除，只能停用");
    }

    await this.users.softDelete(id);
    this.events.emit(USER_DELETED_EVENT, new UserDeletedEvent(id));
  }

  /**
   * 判断系统是否尚未初始化超级管理员；同时校验超级管理员固定唯一（用户名必须为 SUPER_ADMIN_USERNAME 且至多一个）。
   */
  async isNoSuperAdmin(): Promise<boolean> {
    const superAdmins = await this.users.findSuperAdmins();
    this.assertSingleFixedSuperAdmin(superAdmins);
    return superAdmins.length === 0;
  }

  /**
   * 系统初始化用例：仅当尚无超级管理员时创建固定用户名的超级管理员账号，重复调用会因唯一约束或状态校验被拒绝。
   */
  async setupSuperAdmin(newPassword: string) {
    if (!(await this.isNoSuperAdmin())) {
      throw new BadRequestException("系统已初始化");
    }

    const existing =
      await this.users.findSuperAdminByUsername(SUPER_ADMIN_USERNAME);
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
    const user = await this.users.createSuperAdmin({
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
    });
    if (!user) {
      // 并发竞态：另一个请求已抢先创建超级管理员
      throw new BadRequestException("系统已初始化");
    }

    return this.toUserDto(user);
  }

  /**
   * 开发环境启动用例：确保固定用户名的超级管理员存在并同步为已知随机密码，仅供本地/开发免登场景调用。
   */
  async ensureDevSuperAdmin(): Promise<void> {
    const existing =
      await this.users.findSuperAdminByUsername(SUPER_ADMIN_USERNAME);

    if (existing?.deletedAt) {
      throw new Error(
        "超级管理员固定用户名 admin 已被软删除账号占用，请先清理数据库"
      );
    }

    const now = new Date();
    await this.users.syncDevSuperAdmin(
      SUPER_ADMIN_USERNAME,
      {
        passwordHash: await this.passwordHasher.hash(randomUUID()),
        passwordUpdatedAt: now,
        approvedAt: now,
      },
      existing
    );
  }

  /**
   * 用户自助注册；成功后账号处于 pending 状态，需管理员 approve 后才能登录。
   */
  async register(username: string, password: string) {
    const normalizedUsername = normalizeUsername(username);
    const rawPassword = assertPasswordForSet(password, normalizedUsername);

    const existing = await this.users.findIdByUsername(normalizedUsername);
    if (existing) {
      throw new BadRequestException("注册失败，请稍后重试");
    }

    const now = new Date();
    const user = await this.users.create({
      id: generateId(),
      username: normalizedUsername,
      passwordHash: await this.passwordHasher.hash(rawPassword),
      role: "user",
      status: "pending",
      mustChangePassword: false,
      passwordKind: "user_set",
      passwordUpdatedAt: now,
    });
    return this.toUserDto(user);
  }

  /**
   * 校验用户名密码并处理登录失败计数/锁定；成功后返回用户信息，供 auth 模块颁发会话。
   */
  async authenticate(username: string, password: string) {
    const normalizedUsername = normalizeUsername(username);
    const rawPassword = assertPasswordForLogin(password);
    const now = new Date();

    const user = await this.users.findCredentialByUsername(normalizedUsername);
    if (!user) {
      throw new LoginFailedException("user_not_found");
    }

    if (user.lockedUntil && user.lockedUntil > now) {
      throw new LoginFailedException("locked");
    }

    const valid = await this.passwordHasher.compare(
      rawPassword,
      user.passwordHash
    );
    if (!valid) {
      await this.recordFailedLogin(user.id, user.failedLoginCount, user.role);
      throw new LoginFailedException("bad_password");
    }

    this.assertCanLogin(user, now);

    const updated = await this.users.recordSuccessfulLogin(user.id, now);
    return this.toUserDto(updated);
  }

  /**
   * 获取当前登录用户的个人资料；用户不存在时按未授权处理（不暴露用户是否存在）。
   */
  async getProfile(userId: string) {
    const user = await this.users.findById(userId);
    if (!user) throw new UnauthorizedException();
    return this.toUserDto(user);
  }

  /**
   * 用户主动修改密码；需校验当前密码正确且新密码不能与当前密码相同。
   */
  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string
  ) {
    const user = await this.users.findCredentialByIdActive(userId);
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

  /**
   * 强制改密流程（mustChangePassword=true 时）设置新密码；仅当账号处于强制改密状态时可调用。
   */
  async completePasswordChange(userId: string, newPassword: string) {
    const user = await this.users.findCredentialByIdActive(userId);
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

  /**
   * JWT 鉴权守卫使用：按 userId 查找当前有效会话用户，供 guard 校验会话是否仍然合法（返回 null 视为无效会话）。
   */
  async findActiveSessionUser(userId: string): Promise<UserSession | null> {
    const user = await this.users.findSessionUserById(userId);
    return user ? this.toUserSession(user) : null;
  }

  /**
   * 开发免登场景使用：查找固定用户名的超级管理员作为会话用户，不存在时返回 null。
   */
  async findDevSuperAdminSessionUser(): Promise<UserSession | null> {
    const user =
      await this.users.findDevSuperAdminSessionUser(SUPER_ADMIN_USERNAME);
    return user ? this.toUserSession(user) : null;
  }

  private async getUserOrThrow(id: string) {
    const user = await this.users.findById(id);
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
      throw new LoginFailedException("pending");
    }
    if (user.status === "disabled") {
      throw new LoginFailedException("disabled");
    }
    if (user.status !== "active") {
      throw new LoginFailedException("status_invalid");
    }
    if (
      user.mustChangePassword &&
      user.passwordExpiresAt &&
      user.passwordExpiresAt <= now
    ) {
      throw new LoginFailedException("temp_password_expired");
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
    await this.users.recordFailedLogin(
      userId,
      nextCount,
      nextCount >= maxFailedLoginCount
        ? new Date(Date.now() + loginLockMs)
        : null
    );
  }

  private async setUserPassword(userId: string, next: string) {
    const now = new Date();
    const updated = await this.users.setPassword(userId, {
      passwordHash: await this.passwordHasher.hash(next),
      passwordUpdatedAt: now,
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
