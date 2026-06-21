import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import * as bcrypt from "bcryptjs";
import { PrismaService } from "../prisma/prisma.service";
import {
  assertPasswordForLogin,
  assertPasswordForSet,
  assertSuperAdminPasswordForSet,
  normalizeUsername,
  SUPER_ADMIN_USERNAME,
} from "./user-credentials";
import { generateUserId } from "../common/id-generator";

const MAX_FAILED_LOGIN_COUNT = 5;
const LOGIN_LOCK_MS = 15 * 60 * 1000;
const SUPER_ADMIN_MAX_FAILED_LOGIN_COUNT = 3;
const SUPER_ADMIN_LOGIN_LOCK_MS = 30 * 60 * 1000;

type AuthUserRecord = {
  id: string;
  username: string;
  role: string;
  status: string;
  mustChangePassword: boolean;
  passwordKind: string;
  passwordExpiresAt: Date | null;
  sessionVersion: number;
  createdAt?: Date;
};

type SuperAdminIdentity = {
  id: string;
  username: string;
};

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService
  ) {}

  async hashPassword(raw: string): Promise<string> {
    return bcrypt.hash(raw, 10);
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
        id: "admin",
        username: SUPER_ADMIN_USERNAME,
        passwordHash: await this.hashPassword(password),
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

    return {
      token: this.signToken(user),
      user: this.toUserDto(user),
    };
  }

  async login(username: string, password: string) {
    const normalizedUsername = normalizeUsername(username);
    const rawPassword = assertPasswordForLogin(password);
    const now = new Date();

    const user = await this.prisma.user.findFirst({
      where: { username: normalizedUsername, deletedAt: null },
    });
    if (!user) {
      throw new UnauthorizedException("用户不存在");
    }

    if (user.lockedUntil && user.lockedUntil > now) {
      throw new UnauthorizedException("登录失败次数过多，请稍后再试");
    }

    const valid = await bcrypt.compare(rawPassword, user.passwordHash);
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

    return {
      token: this.signToken(updated),
      user: this.toUserDto(updated),
    };
  }

  async register(username: string, password: string) {
    const normalizedUsername = normalizeUsername(username);
    const rawPassword = assertPasswordForSet(password, normalizedUsername);

    const existing = await this.prisma.user.findFirst({
      where: { username: normalizedUsername },
      select: { id: true },
    });
    if (existing)
      throw new BadRequestException("注册失败，请稍后重试");

    const now = new Date();
    const id = await generateUserId(this.prisma);
    const user = await this.prisma.user.create({
      data: {
        id,
        username: normalizedUsername,
        passwordHash: await this.hashPassword(rawPassword),
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
    });
    if (!user) throw new UnauthorizedException();

    const current = assertPasswordForLogin(currentPassword);
    const next =
      user.role === "super_admin"
        ? assertSuperAdminPasswordForSet(newPassword, user.username)
        : assertPasswordForSet(newPassword, user.username);
    const valid = await bcrypt.compare(current, user.passwordHash);
    if (!valid) throw new UnauthorizedException("当前密码错误");
    if (await bcrypt.compare(next, user.passwordHash)) {
      throw new BadRequestException("新密码不能和当前密码相同");
    }

    return this.setUserPassword(user.id, next);
  }

  async completePasswordChange(userId: string, newPassword: string) {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, status: "active", deletedAt: null },
    });
    if (!user) throw new UnauthorizedException();
    if (!user.mustChangePassword) {
      throw new BadRequestException("当前账号不需要强制修改密码");
    }

    const next =
      user.role === "super_admin"
        ? assertSuperAdminPasswordForSet(newPassword, user.username)
        : assertPasswordForSet(newPassword, user.username);
    if (await bcrypt.compare(next, user.passwordHash)) {
      throw new BadRequestException("新密码不能和当前密码相同");
    }

    return this.setUserPassword(user.id, next);
  }

  private async setUserPassword(userId: string, next: string) {
    const now = new Date();
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: {
        passwordHash: await this.hashPassword(next),
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
    return {
      token: this.signToken(updated),
      user: this.toUserDto(updated),
    };
  }

  private assertCanLogin(
    user: AuthUserRecord & {
      passwordHash: string;
      lockedUntil?: Date | null;
      failedLoginCount?: number;
    },
    now: Date
  ) {
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

  private userSelect() {
    return {
      id: true,
      username: true,
      role: true,
      status: true,
      mustChangePassword: true,
      passwordKind: true,
      passwordExpiresAt: true,
      sessionVersion: true,
      createdAt: true,
    } as const;
  }

  private toUserDto(user: AuthUserRecord) {
    return {
      id: user.id,
      username: user.username,
      role: user.role,
      status: user.status,
      mustChangePassword: user.mustChangePassword,
      passwordKind: user.passwordKind,
      passwordExpiresAt: user.passwordExpiresAt?.toISOString() ?? null,
      sessionVersion: user.sessionVersion,
      ...(user.createdAt ? { createdAt: user.createdAt.toISOString() } : {}),
    };
  }

  private signToken(user: {
    id: string;
    username: string;
    role: string;
    sessionVersion: number;
  }) {
    return this.jwtService.sign({
      sub: user.id,
      username: user.username,
      role: user.role,
      sessionVersion: user.sessionVersion,
    });
  }

}
