import {
  createParamDecorator,
  ExecutionContext,
  UnauthorizedException,
} from "@nestjs/common";
import type { UserSession } from "../users/user-session";

export type JwtUser = UserSession;

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): JwtUser => {
    const request = ctx.switchToHttp().getRequest<{ user?: JwtUser }>();
    if (!request.user) throw new UnauthorizedException();
    return request.user;
  }
);
