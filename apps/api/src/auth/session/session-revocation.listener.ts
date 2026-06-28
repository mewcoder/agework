import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import {
  USER_DELETED_EVENT,
  USER_DISABLED_EVENT,
  USER_PASSWORD_RESET_EVENT,
  UserDeletedEvent,
  UserDisabledEvent,
  UserPasswordResetEvent,
} from "../../users/user.events";
import { SessionService } from "./session.service";

/**
 * 监听 users 领域的状态/凭据变更事件，撤销该用户的登录会话，
 * 使 refresh token 立即失效（access token 由 sessionVersion 在 guard 侧拦截）。
 * best-effort：失败仅记录日志，不影响来源操作。
 */
@Injectable()
export class SessionRevocationListener {
  private readonly logger = new Logger(SessionRevocationListener.name);

  constructor(private readonly sessions: SessionService) {}

  @OnEvent([USER_DELETED_EVENT, USER_DISABLED_EVENT, USER_PASSWORD_RESET_EVENT])
  async onSessionsShouldRevoke({
    userId,
  }:
    | UserDeletedEvent
    | UserDisabledEvent
    | UserPasswordResetEvent): Promise<void> {
    try {
      await this.sessions.revokeAllForUser(userId);
    } catch (err) {
      this.logger.warn(
        `revokeAllForUser failed for ${userId}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}
