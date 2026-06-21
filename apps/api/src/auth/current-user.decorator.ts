import {
  createParamDecorator,
  ExecutionContext,
  UnauthorizedException,
} from "@nestjs/common";

export interface JwtUser {
  userId: string;
  username: string;
  role: string;
  status: string;
  mustChangePassword: boolean;
  sessionVersion: number;
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): JwtUser => {
    const request = ctx.switchToHttp().getRequest<{ user?: JwtUser }>();
    if (!request.user) throw new UnauthorizedException();
    return request.user;
  }
);
