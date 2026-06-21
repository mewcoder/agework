import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { JwtService } from "@nestjs/jwt";
import { PrismaService } from "../prisma/prisma.service";
import { isDevAuthDisabled } from "./dev-auth";
import { extractBearerToken } from "./extract-bearer-token";
import { IS_PUBLIC_KEY } from "./public.decorator";
import { SUPER_ADMIN_USERNAME } from "./user-credentials";
import type { JwtUser } from "./current-user.decorator";

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
    private prisma: PrismaService
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
      const userRecord = await this.prisma.user.findFirst({
        where: { id: payload.sub, status: "active", deletedAt: null },
        select: {
          id: true,
          username: true,
          role: true,
          status: true,
          mustChangePassword: true,
          sessionVersion: true,
        },
      });
      if (!userRecord) throw new UnauthorizedException();
      if (payload.sessionVersion !== userRecord.sessionVersion) {
        throw new UnauthorizedException();
      }
      const user: JwtUser = {
        userId: userRecord.id,
        username: userRecord.username,
        role: userRecord.role,
        status: userRecord.status,
        mustChangePassword: userRecord.mustChangePassword,
        sessionVersion: userRecord.sessionVersion,
      };
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
    const userRecord = await this.prisma.user.findFirst({
      where: {
        username: SUPER_ADMIN_USERNAME,
        role: "super_admin",
        status: "active",
        deletedAt: null,
      },
      select: {
        id: true,
        username: true,
        role: true,
        status: true,
        mustChangePassword: true,
        sessionVersion: true,
      },
    });
    if (!userRecord) throw new UnauthorizedException();

    return {
      userId: userRecord.id,
      username: userRecord.username,
      role: userRecord.role,
      status: userRecord.status,
      mustChangePassword: userRecord.mustChangePassword,
      sessionVersion: userRecord.sessionVersion,
    };
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
