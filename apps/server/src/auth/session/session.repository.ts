import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";

export type SessionRecord = {
  id: string;
  userId: string;
  expiresAt: Date;
  revokedAt: Date | null;
};

export type SessionCreateData = {
  id: string;
  userId: string;
  refreshTokenHash: string;
  expiresAt: Date;
};

/**
 * Session 领域持久化边界：封装对 Session 表的 Prisma 访问。
 * 只读写 refresh token 的 hash，绝不落明文。
 */
@Injectable()
export class SessionRepository {
  constructor(private prisma: PrismaService) {}

  async create(data: SessionCreateData): Promise<void> {
    await this.prisma.session.create({ data });
  }

  findByHash(refreshTokenHash: string): Promise<SessionRecord | null> {
    return this.prisma.session.findUnique({
      where: { refreshTokenHash },
      select: { id: true, userId: true, expiresAt: true, revokedAt: true },
    });
  }

  async revokeById(id: string, revokedAt: Date): Promise<void> {
    await this.prisma.session.updateMany({
      where: { id, revokedAt: null },
      data: { revokedAt },
    });
  }

  /** 原子轮换：撤销旧会话并写入新会话，避免出现两者都失效的中间态。 */
  async rotate(
    oldId: string,
    next: SessionCreateData,
    revokedAt: Date
  ): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.session.updateMany({
        where: { id: oldId, revokedAt: null },
        data: { revokedAt },
      }),
      this.prisma.session.create({ data: next }),
    ]);
  }

  async revokeAllForUser(userId: string, revokedAt: Date): Promise<void> {
    await this.prisma.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt },
    });
  }

  async touch(id: string, lastUsedAt: Date): Promise<void> {
    await this.prisma.session.update({
      where: { id },
      data: { lastUsedAt },
    });
  }
}
