import { describe, it, expect, beforeEach } from "vitest";
import { UnauthorizedException } from "@nestjs/common";
import { SessionService } from "./session.service";
import type {
  SessionRepository,
  SessionCreateData,
} from "./session.repository";

type Row = {
  id: string;
  userId: string;
  refreshTokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
};

class FakeSessionRepository {
  rows: Row[] = [];

  async create(data: SessionCreateData) {
    this.rows.push({ ...data, revokedAt: null });
  }
  async findByHash(hash: string) {
    return this.rows.find((r) => r.refreshTokenHash === hash) ?? null;
  }
  async revokeById(id: string, revokedAt: Date) {
    const row = this.rows.find((r) => r.id === id && !r.revokedAt);
    if (row) row.revokedAt = revokedAt;
  }
  async revokeAllForUser(userId: string, revokedAt: Date) {
    this.rows
      .filter((r) => r.userId === userId && !r.revokedAt)
      .forEach((r) => (r.revokedAt = revokedAt));
  }
  async rotate(oldId: string, next: SessionCreateData, revokedAt: Date) {
    await this.revokeById(oldId, revokedAt);
    await this.create(next);
  }
  async touch() {}
}

function makeService() {
  const repo = new FakeSessionRepository();
  const service = new SessionService(repo as unknown as SessionRepository);
  return { service, repo };
}

describe("SessionService", () => {
  let service: SessionService;
  let repo: FakeSessionRepository;

  beforeEach(() => {
    ({ service, repo } = makeService());
  });

  it("issues a refresh token and stores only its hash", async () => {
    const { rawToken } = await service.issue("user-1");

    expect(rawToken).toBeTruthy();
    expect(repo.rows).toHaveLength(1);
    expect(repo.rows[0].refreshTokenHash).not.toBe(rawToken);
    expect(repo.rows[0].userId).toBe("user-1");
  });

  it("rotates a valid token into a new usable token", async () => {
    const { rawToken } = await service.issue("user-1");

    const rotated = await service.rotate(rawToken);
    expect(rotated.userId).toBe("user-1");
    expect(rotated.rawToken).not.toBe(rawToken);

    // 新 token 可继续轮换出再下一个
    const again = await service.rotate(rotated.rawToken);
    expect(again.userId).toBe("user-1");
    expect(again.rawToken).not.toBe(rotated.rawToken);
  });

  it("rejects an unknown token", async () => {
    await expect(service.rotate("never-issued")).rejects.toBeInstanceOf(
      UnauthorizedException
    );
  });

  it("treats reuse of a revoked token as theft and revokes all user sessions", async () => {
    const first = await service.issue("user-1");
    // 同一用户的另一台设备会话
    await service.issue("user-1");
    const rotated = await service.rotate(first.rawToken); // first 被撤销

    // 重放已撤销的 first.rawToken
    await expect(service.rotate(first.rawToken)).rejects.toBeInstanceOf(
      UnauthorizedException
    );

    // 该用户的所有会话（含刚轮换出的新 token、另一设备会话）全部失效
    expect(repo.rows.every((r) => r.userId !== "user-1" || r.revokedAt)).toBe(
      true
    );
    await expect(service.rotate(rotated.rawToken)).rejects.toBeInstanceOf(
      UnauthorizedException
    );
  });

  it("rejects and revokes an expired token", async () => {
    const { rawToken } = await service.issue("user-1");
    repo.rows[0].expiresAt = new Date(Date.now() - 1000);

    await expect(service.rotate(rawToken)).rejects.toBeInstanceOf(
      UnauthorizedException
    );
    expect(repo.rows[0].revokedAt).not.toBeNull();
  });

  it("revoke makes the current token unusable; revokeAllForUser kills every session", async () => {
    const { rawToken } = await service.issue("user-1");
    await service.revoke(rawToken);
    expect(repo.rows[0].revokedAt).not.toBeNull();

    const a = await service.issue("user-2");
    await service.issue("user-2");
    await service.revokeAllForUser("user-2");
    expect(
      repo.rows.filter((r) => r.userId === "user-2").every((r) => r.revokedAt)
    ).toBe(true);
    await expect(service.rotate(a.rawToken)).rejects.toBeInstanceOf(
      UnauthorizedException
    );
  });
});
