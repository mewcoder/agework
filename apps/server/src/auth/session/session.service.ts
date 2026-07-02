import { Injectable, Logger, UnauthorizedException } from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import { generateId } from "@agework/shared";
import { SessionRepository } from "./session.repository";

export const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const REFRESH_TOKEN_BYTES = 32;

export type IssuedRefreshToken = {
  rawToken: string;
  expiresAt: Date;
};

export type RotatedRefreshToken = IssuedRefreshToken & {
  userId: string;
};

/**
 * 内部能力提供方：管理 refresh token 的签发、轮换、撤销。
 * token 本身是高熵随机串，库里只存其 SHA-256；明文只在签发/轮换时返回一次，
 * 由上层放进 HttpOnly cookie。被 AuthService 编排，不对外导出。
 */
@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);

  constructor(private readonly sessions: SessionRepository) {}

  async issue(userId: string): Promise<IssuedRefreshToken> {
    const rawToken = randomBytes(REFRESH_TOKEN_BYTES).toString("base64url");
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);
    await this.sessions.create({
      id: generateId(),
      userId,
      refreshTokenHash: hashToken(rawToken),
      expiresAt,
    });
    return { rawToken, expiresAt };
  }

  /**
   * 轮换：校验旧 token 后撤销并签发新 token。
   * - 找不到：无效，拒绝。
   * - 已撤销：判定为 token 重用（疑似失窃），撤销该用户全部会话并拒绝。
   * - 已过期：撤销并拒绝。
   */
  async rotate(rawToken: string): Promise<RotatedRefreshToken> {
    const now = new Date();
    const session = await this.sessions.findByHash(hashToken(rawToken));
    if (!session) {
      throw new UnauthorizedException("登录已失效，请重新登录");
    }
    if (session.revokedAt) {
      this.logger.warn(
        `refresh token reuse detected for user ${session.userId}, revoking all sessions`
      );
      await this.sessions.revokeAllForUser(session.userId, now);
      throw new UnauthorizedException("登录已失效，请重新登录");
    }
    if (session.expiresAt <= now) {
      await this.sessions.revokeById(session.id, now);
      throw new UnauthorizedException("登录已过期，请重新登录");
    }

    const rawNextToken = randomBytes(REFRESH_TOKEN_BYTES).toString("base64url");
    const expiresAt = new Date(now.getTime() + REFRESH_TOKEN_TTL_MS);
    await this.sessions.rotate(
      session.id,
      {
        id: generateId(),
        userId: session.userId,
        refreshTokenHash: hashToken(rawNextToken),
        expiresAt,
      },
      now
    );
    return { rawToken: rawNextToken, expiresAt, userId: session.userId };
  }

  /** 登出：撤销当前 refresh token 对应的会话。找不到则静默忽略（幂等）。 */
  async revoke(rawToken: string): Promise<void> {
    const session = await this.sessions.findByHash(hashToken(rawToken));
    if (session && !session.revokedAt) {
      await this.sessions.revokeById(session.id, new Date());
    }
  }

  revokeAllForUser(userId: string): Promise<void> {
    return this.sessions.revokeAllForUser(userId, new Date());
  }
}

function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}
