import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { JwtService } from "@nestjs/jwt";
import { isDevAuthDisabled } from "./dev-auth";
import { extractBearerToken } from "../common/extract-bearer-token";
import { IS_PUBLIC_KEY } from "./public.decorator";
import type { JwtUser } from "./current-user.decorator";
import { UserService } from "../users/user.service";

type RequestWithUser = {
  headers: Record<string, string | string[] | undefined>;
  method?: string;
  originalUrl?: string;
  path?: string;
  url?: string;
  user?: JwtUser;
};

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private jwtService: JwtService,
    private reflector: Reflector,
    private users: UserService
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<RequestWithUser>();

    if (isDevAuthDisabled()) {
      request.user = await this.loadDevAdminUser();
      return true;
    }

    const token = extractBearerToken(request.headers);

    if (!token) throw new UnauthorizedException();

    try {
      const payload = this.jwtService.verify<{
        sub: string;
        username: string;
        role: string;
        sessionVersion?: number;
      }>(token);
      const user = await this.users.findActiveSessionUser(payload.sub);
      if (!user) throw new UnauthorizedException();
      if (payload.sessionVersion !== user.sessionVersion) {
        throw new UnauthorizedException();
      }
      if (user.mustChangePassword && !this.canUseTemporaryPassword(request)) {
        throw new UnauthorizedException("请先修改密码");
      }
      request.user = user;
      return true;
    } catch {
      throw new UnauthorizedException();
    }
  }

  private async loadDevAdminUser(): Promise<JwtUser> {
    const user = await this.users.findDevSuperAdminSessionUser();
    if (!user) throw new UnauthorizedException();
    return user;
  }

  private canUseTemporaryPassword(request: RequestWithUser) {
    if (request.method === "OPTIONS") return true;

    const fullPath = request.originalUrl ?? request.path ?? request.url ?? "";
    // 去掉 query string，只匹配路径部分
    const path = fullPath.split("?")[0];
    return (
      path.endsWith("/auth/query") ||
      path.endsWith("/auth/update-password")
    );
  }
}
