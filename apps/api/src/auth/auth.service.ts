import { ForbiddenException, Injectable } from "@nestjs/common";
import { timingSafeEqual } from "node:crypto";
import { JwtService } from "@nestjs/jwt";
import { UserService } from "../users/user.service";
import { ConfigService } from "../config/config.service";

type TokenUser = {
  id: string;
  username: string;
  role: string;
  sessionVersion: number;
};

@Injectable()
export class AuthService {
  constructor(
    private readonly users: UserService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService
  ) {}

  isSetupRequired(): Promise<boolean> {
    return this.users.isSetupRequired();
  }

  async config() {
    const authRequired = !this.configService.isDevAuthDisabled();
    return {
      authRequired,
      appName: this.configService.getAppName(),
      registrationMode: "approval",
      setupRequired: authRequired
        ? await this.users.isSetupRequired()
        : false,
    };
  }

  async setupSuperAdmin(newPassword: string, adminInitKey?: string) {
    this.assertSetupAuthorized(adminInitKey);
    const user = await this.users.setupSuperAdmin(newPassword);
    return {
      token: this.signToken(user),
      user,
    };
  }

  /**
   * 生产环境初始化必须出示与 AGEWORK_PRIVATE_ADMIN_INIT_KEY 一致的引导密钥，
   * 未配置即拒绝（fail closed），防止公网部署被抢注超级管理员。
   */
  private assertSetupAuthorized(adminInitKey?: string) {
    if (!this.configService.requiresAdminInitKey()) return;

    const expected = this.configService.getAdminInitKey();
    if (!expected) {
      throw new ForbiddenException(
        "生产环境未配置 AGEWORK_PRIVATE_ADMIN_INIT_KEY，已拒绝初始化"
      );
    }
    if (!adminInitKey || !safeEqual(adminInitKey, expected)) {
      throw new ForbiddenException("初始化密钥无效");
    }
  }

  async login(username: string, password: string) {
    const user = await this.users.authenticate(username, password);
    return {
      token: this.signToken(user),
      user,
    };
  }

  register(username: string, password: string) {
    return this.users.register(username, password);
  }

  me(userId: string) {
    return this.users.me(userId);
  }

  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string
  ) {
    const user = await this.users.changePassword(
      userId,
      currentPassword,
      newPassword
    );
    return {
      token: this.signToken(user),
      user,
    };
  }

  async completePasswordChange(userId: string, newPassword: string) {
    const user = await this.users.completePasswordChange(userId, newPassword);
    return {
      token: this.signToken(user),
      user,
    };
  }

  private signToken(user: TokenUser) {
    return this.jwtService.sign({
      sub: user.id,
      username: user.username,
      role: user.role,
      sessionVersion: user.sessionVersion,
    });
  }
}

/** 常量时间比较，避免通过响应耗时旁路猜测 token。 */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
