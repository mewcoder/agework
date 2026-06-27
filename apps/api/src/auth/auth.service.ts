import { Injectable } from "@nestjs/common";
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

  async setupSuperAdmin(newPassword: string) {
    const user = await this.users.setupSuperAdmin(newPassword);
    return {
      token: this.signToken(user),
      user,
    };
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
