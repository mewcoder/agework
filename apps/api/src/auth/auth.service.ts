import { ForbiddenException, Injectable } from "@nestjs/common";
import { timingSafeEqual } from "node:crypto";
import { JwtService } from "@nestjs/jwt";
import { UserService } from "../user/user.service";
import { ConfigService } from "../config/config.service";
import { SessionService } from "./session/session.service";

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
    private readonly configService: ConfigService,
    private readonly sessions: SessionService
  ) {}

  async isNoSuperAdmin(): Promise<boolean> {
    return this.users.isNoSuperAdmin();
  }

  async getAuthConfig() {
    const authRequired = !this.configService.isDevAuthDisabled();
    return {
      authRequired,
      appName: this.configService.getAppName(),
      registrationMode: "approval",
      setupRequired: authRequired ? await this.users.isNoSuperAdmin() : false,
    };
  }

  async setupSuperAdmin(newPassword: string, adminInitKey?: string) {
    this.assertSetupAuthorized(adminInitKey);
    const user = await this.users.setupSuperAdmin(newPassword);
    return this.startSession(user);
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
    return this.startSession(user);
  }

  /** 用 refresh token 轮换出新的 access token，并下发新的 refresh token。 */
  async refreshToken(rawRefreshToken: string) {
    const rotated = await this.sessions.rotate(rawRefreshToken);
    const user = await this.users.getProfile(rotated.userId);
    return {
      token: this.signToken(user),
      refreshToken: rotated.rawToken,
      user,
    };
  }

  /** 登出：撤销当前 refresh token 对应的会话。无 token 时静默忽略。 */
  async logout(rawRefreshToken: string | undefined) {
    if (rawRefreshToken) {
      await this.sessions.revoke(rawRefreshToken);
    }
  }

  register(username: string, password: string) {
    return this.users.register(username, password);
  }

  getUserInfo(userId: string) {
    return this.users.getProfile(userId);
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
    return this.rotateSessionsAfterPasswordChange(user);
  }

  async completePasswordChange(userId: string, newPassword: string) {
    const user = await this.users.completePasswordChange(userId, newPassword);
    return this.rotateSessionsAfterPasswordChange(user);
  }

  /** 改密后撤销该用户所有旧会话（旧 refresh token 立即失效），再为当前设备签发新会话。 */
  private async rotateSessionsAfterPasswordChange<T extends TokenUser>(
    user: T
  ) {
    await this.sessions.revokeAllForUser(user.id);
    return this.startSession(user);
  }

  private async startSession<T extends TokenUser>(user: T) {
    const { rawToken } = await this.sessions.issue(user.id);
    return {
      token: this.signToken(user),
      refreshToken: rawToken,
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
