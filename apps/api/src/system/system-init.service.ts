import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { isDevAuthDisabled } from "../auth/dev-auth";
import { SETTINGS_REGISTRY } from "../config/settings-registry";
import { UserService } from "../users/user.service";

@Injectable()
export class SystemInitService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SystemInitService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly users: UserService
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.seedDefaultSystemSettings();

    if (!isDevAuthDisabled()) return;

    this.logger.warn(
      "开发登录验证已关闭: AGEWORK_DEV_AUTH_DISABLED=true，将自动使用真实 admin 超级管理员。"
    );
    await this.users.ensureDevSuperAdmin();
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
}
