import {
  Body,
  Controller,
  Get,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { SkipThrottle, ThrottlerGuard } from "@nestjs/throttler";
import {
  AUTH_THROTTLER_IP,
  AUTH_THROTTLER_IP_USERNAME,
} from "./guards/auth-throttler";
import { AuthService } from "./auth.service";
import { ConfigService } from "../config/config.service";
import { Public } from "./decorators/public.decorator";
import { CurrentUser } from "./decorators/current-user.decorator";
import type { JwtUser } from "./auth.types";
import { LoginDto } from "./dto/login.dto";
import { RegisterDto } from "./dto/register.dto";
import { ChangePasswordDto } from "./dto/change-password.dto";
import { SetupDto } from "./dto/setup.dto";
import {
  clearRefreshCookie,
  readRefreshCookie,
  setRefreshCookie,
} from "./session/refresh-cookie";

type SessionResult = { token: string; refreshToken: string; user: unknown };

// 裸 @SkipThrottle() 只跳过名为 default 的桶;本控制器用的是两个命名桶,
// 必须按名字逐个跳过,否则 config/query 这类高频只读端点照样进防爆破计数
// (曾在 e2e 全量跑时被 20 次/分钟的 auth-ip 桶误伤成 429)。
const SKIP_AUTH_THROTTLERS = {
  [AUTH_THROTTLER_IP]: true,
  [AUTH_THROTTLER_IP_USERNAME]: true,
};

@UseGuards(ThrottlerGuard)
@Controller("auth")
export class AuthController {
  constructor(
    private authService: AuthService,
    private configService: ConfigService
  ) {}

  @Public()
  @Post("login")
  async login(
    @Body() body: LoginDto,
    @Res({ passthrough: true }) res: Response
  ) {
    const result = await this.authService.login(body.username, body.password);
    return this.issueSession(res, result);
  }

  @Public()
  @Post("register")
  register(@Body() body: RegisterDto) {
    return this.authService.register(body.username, body.password);
  }

  @Public()
  @Post("setup")
  async setup(
    @Body() body: SetupDto,
    @Res({ passthrough: true }) res: Response
  ) {
    const result = await this.authService.setupSuperAdmin(
      body.newPassword,
      body.adminInitKey
    );
    return this.issueSession(res, result);
  }

  @Public()
  @Post("refresh")
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response
  ) {
    const rawToken = readRefreshCookie(req);
    if (!rawToken) {
      clearRefreshCookie(res, this.configService.isProduction());
      throw new UnauthorizedException();
    }
    const result = await this.authService.refreshToken(rawToken);
    return this.issueSession(res, result);
  }

  @Public()
  @Post("logout")
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.authService.logout(readRefreshCookie(req));
    clearRefreshCookie(res, this.configService.isProduction());
    return { ok: true };
  }

  @SkipThrottle(SKIP_AUTH_THROTTLERS)
  @Get("query")
  me(@CurrentUser() user: JwtUser) {
    return this.authService.getUserInfo(user.userId);
  }

  @Post("update-password")
  async updatePassword(
    @Body() body: ChangePasswordDto,
    @CurrentUser() user: JwtUser,
    @Res({ passthrough: true }) res: Response
  ) {
    const result =
      body.currentPassword === undefined
        ? await this.authService.completePasswordChange(
            user.userId,
            body.newPassword
          )
        : await this.authService.changePassword(
            user.userId,
            body.currentPassword,
            body.newPassword
          );
    return this.issueSession(res, result);
  }

  @SkipThrottle(SKIP_AUTH_THROTTLERS)
  @Public()
  @Get("config")
  config() {
    return this.authService.getAuthConfig();
  }

  /** 把 refresh token 写进 HttpOnly cookie，响应体只回 access token 与用户信息。 */
  private issueSession(res: Response, result: SessionResult) {
    setRefreshCookie(
      res,
      result.refreshToken,
      this.configService.isProduction()
    );
    return { token: result.token, user: result.user };
  }
}
