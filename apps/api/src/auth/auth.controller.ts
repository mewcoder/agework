import { Body, Controller, Get, Post } from "@nestjs/common";
import { AuthService } from "./auth.service";
import { Public } from "./decorators/public.decorator";
import { CurrentUser } from "./decorators/current-user.decorator";
import type { JwtUser } from "./decorators/current-user.decorator";
import { LoginDto } from "./dto/login.dto";
import { RegisterDto } from "./dto/register.dto";
import { ChangePasswordDto } from "./dto/change-password.dto";
import { SetupDto } from "./dto/setup.dto";

@Controller("auth")
export class AuthController {
  constructor(private authService: AuthService) {}

  @Public()
  @Post("login")
  login(@Body() body: LoginDto) {
    return this.authService.login(body.username, body.password);
  }

  @Public()
  @Post("register")
  register(@Body() body: RegisterDto) {
    return this.authService.register(body.username, body.password);
  }

  @Public()
  @Post("setup")
  setup(@Body() body: SetupDto) {
    return this.authService.setupSuperAdmin(body.newPassword);
  }

  @Get("query")
  me(@CurrentUser() user: JwtUser) {
    return this.authService.me(user.userId);
  }

  @Post("update-password")
  updatePassword(
    @Body() body: ChangePasswordDto,
    @CurrentUser() user: JwtUser
  ) {
    if (body.currentPassword === undefined) {
      return this.authService.completePasswordChange(
        user.userId,
        body.newPassword
      );
    }

    return this.authService.changePassword(
      user.userId,
      body.currentPassword,
      body.newPassword
    );
  }

  @Public()
  @Get("config")
  config() {
    return this.authService.config();
  }
}
