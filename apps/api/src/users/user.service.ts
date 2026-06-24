import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { AuthService } from "../auth/auth.service";
import type { JwtUser } from "../auth/current-user.decorator";
import {
  generateTemporaryPassword,
  normalizeRole,
  normalizeStatus,
  normalizeUsername,
} from "../auth/user-credentials";
import { PrismaService } from "../prisma/prisma.service";
import { RuntimeResourceLifecycleUseCase } from "../runtime/core/runtime-resources/runtime-resource-lifecycle.use-case";
import { generateUserId } from "../common/id-generator";

const INITIAL_PASSWORD_TTL_MS = 72 * 60 * 60 * 1000;
const RESET_PASSWORD_TTL_MS = 24 * 60 * 60 * 1000;

type UserRecord = {
  id: string;
  username: string;
  role: string;
  status: string;
  mustChangePassword: boolean;
  passwordKind: string;
  passwordExpiresAt: Date | null;
  approvedAt: Date | null;
  approvedById: string | null;
  lastLoginAt: Date | null;
  createdAt: Date;
};

@Injectable()
export class UserService {
  constructor(
    private prisma: PrismaService,
    private authService: AuthService,
    private runtimeLifecycleService: RuntimeResourceLifecycleUseCase
  ) {}

  async list(operator: JwtUser, pagination?: { take: number; skip: number }) {
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

  async create(operator: JwtUser, username: string, role = "user") {
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
    if (existing)
      throw new BadRequestException(`用户名 ${normalizedUsername} 已存在`);

    const temporaryPassword = generateTemporaryPassword();
    const now = new Date();
    const passwordExpiresAt = new Date(now.getTime() + INITIAL_PASSWORD_TTL_MS);
    const id = await generateUserId();
    const user = await this.prisma.user.create({
      data: {
        id,
        username: normalizedUsername,
        passwordHash: await this.authService.hashPassword(temporaryPassword),
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

  async approve(id: string, operator: JwtUser) {
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
    operator: JwtUser
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

    // 用户被禁用时关闭其 runtime 资源
    if (data.status !== undefined && normalizeStatus(data.status) === "disabled") {
      await this.shutdownUserRuntimes(id);
    }

    return this.toUserDto(updated);
  }

  async resetPassword(id: string, operator: JwtUser) {
    const user = await this.getUserOrThrow(id);
    this.assertCanManage(operator, user, "reset-password");

    const temporaryPassword = generateTemporaryPassword();
    const now = new Date();
    const passwordExpiresAt = new Date(now.getTime() + RESET_PASSWORD_TTL_MS);
    const updated = await this.prisma.user.update({
      where: { id },
      data: {
        passwordHash: await this.authService.hashPassword(temporaryPassword),
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

  async delete(id: string, operator: JwtUser) {
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

    // 关闭该用户的 runtime 资源
    await this.shutdownUserRuntimes(id);
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
    operator: JwtUser,
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
    // 防御性兜底：新增 action 类型时不应静默通过授权检查
    throw new ForbiddenException("未授权的操作");
  }

  private operatorId(operator: JwtUser) {
    return operator.userId;
  }

  /** 关闭该用户相关的全部 runtime 资源（用户共享资源 + 该用户所有 workspace 的资源）。 */
  private async shutdownUserRuntimes(userId: string): Promise<void> {
    await this.runtimeLifecycleService.shutdownForUser(userId);
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
      approvedAt: true,
      approvedById: true,
      lastLoginAt: true,
      createdAt: true,
    } as const;
  }

  private toUserDto(user: UserRecord) {
    return {
      id: user.id,
      username: user.username,
      role: user.role,
      status: user.status,
      mustChangePassword: user.mustChangePassword,
      passwordKind: user.passwordKind,
      passwordExpiresAt: user.passwordExpiresAt?.toISOString() ?? null,
      approvedAt: user.approvedAt?.toISOString() ?? null,
      approvedById: user.approvedById,
      lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
      createdAt: user.createdAt.toISOString(),
    };
  }
}
