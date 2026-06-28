import { Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { ConfigService } from "../../config/config.service";
import { UserService } from "../../users/user.service";

@Injectable()
export class SystemInitService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SystemInitService.name);

  constructor(
    private readonly users: UserService,
    private readonly configService: ConfigService
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.configService.seedDefaults();

    if (!this.configService.isDevAuthDisabled()) return;

    this.logger.warn(
      "开发登录验证已关闭: AGEWORK_DEV_AUTH_DISABLED=true，将自动使用真实 admin 超级管理员。"
    );
    await this.users.ensureDevSuperAdmin();
  }
}
