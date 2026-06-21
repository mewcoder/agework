import { randomUUID } from "node:crypto";
import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from "@nestjs/common";
import * as bcrypt from "bcryptjs";
import { PrismaService } from "../prisma/prisma.service";
import { isDevAuthDisabled } from "../auth/dev-auth";
import { SUPER_ADMIN_USERNAME } from "../auth/user-credentials";
import { SETTINGS_REGISTRY } from "../config/settings-registry";

@Injectable()
export class SystemInitService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SystemInitService.name);

  constructor(private readonly prisma: PrismaService) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.seedDefaultSystemSettings();

    if (!isDevAuthDisabled()) return;

    this.logger.warn(
      "开发登录验证已关闭: AGEWORK_DEV_AUTH_DISABLED=true，将自动使用真实 admin 超级管理员。"
    );
    await this.ensureDevSuperAdmin();
  }

  /** 为 SETTINGS_REGISTRY 中尚未写入数据库的配置项写入默认值，已有记录不覆盖。 */
  private async seedDefaultSystemSettings() {
    for (const definition of SETTINGS_REGISTRY) {
      const existing = await this.prisma.systemSetting.findUnique({
        where: { key: definition.key },
        select: { key: true },
      });
      if (existing) continue;

      await this.prisma.systemSetting.create({
        data: {
          key: definition.key,
          value: process.env[definition.key] ?? definition.defaultValue,
        },
      });
    }
  }

  private async ensureDevSuperAdmin() {
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
      passwordHash: await bcrypt.hash(randomUUID(), 10),
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
        id: "admin",
        username: SUPER_ADMIN_USERNAME,
        ...data,
      },
    });
  }
}
