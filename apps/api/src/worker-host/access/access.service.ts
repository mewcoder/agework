import { Injectable } from "@nestjs/common";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const ACCESS_KEY_BYTES = 32;

@Injectable()
export class WorkerAccessService {
  private readonly accessKeys = new Map<string, string>();
  /** ownerId → accessKey（持久容器复用，一个 owner 一个 key） */
  private readonly ownerKeys = new Map<string, string>();

  /**
   * 为单个 run 签发内部访问 key。
   * Worker 用它访问 /worker/runs/*；run 清理时可撤销。
   */
  issueAccessKey(runId: string): string {
    const accessKey = randomBytes(ACCESS_KEY_BYTES).toString("base64url");
    this.accessKeys.set(runId, accessKey);
    return accessKey;
  }

  /**
   * 为 runtime owner 签发内部访问 key。
   * Worker 用同一个 key 访问 per-run 端点和 owner 命令端点。
   */
  issueOwnerKey(ownerId: string): string {
    const accessKey = randomBytes(ACCESS_KEY_BYTES).toString("base64url");
    this.ownerKeys.set(ownerId, accessKey);
    return accessKey;
  }

  /** 把某个 run 绑定到 owner key，使 per-run 端点用 owner key 即可通过。 */
  registerRun(runId: string, ownerKey: string): void {
    this.accessKeys.set(runId, ownerKey);
  }

  verifyAccessKey(runId: string, accessKey: string): boolean {
    return this.constantTimeEqual(this.accessKeys.get(runId), accessKey);
  }

  verifyOwnerKey(ownerId: string, accessKey: string): boolean {
    return this.constantTimeEqual(this.ownerKeys.get(ownerId), accessKey);
  }

  revokeAccess(runId: string): void {
    this.accessKeys.delete(runId);
  }

  revokeOwner(ownerId: string): void {
    const key = this.ownerKeys.get(ownerId);
    this.ownerKeys.delete(ownerId);
    if (key) {
      for (const [runId, k] of this.accessKeys) {
        if (k === key) this.accessKeys.delete(runId);
      }
    }
  }

  diagnostics(params: {
    runId?: string;
    ownerId?: string;
    accessKey?: string;
  }): Record<string, unknown> {
    const runKey = params.runId
      ? this.accessKeys.get(params.runId)
      : undefined;
    const ownerKey = params.ownerId
      ? this.ownerKeys.get(params.ownerId)
      : undefined;

    return {
      accessKeyCount: this.accessKeys.size,
      ownerKeyCount: this.ownerKeys.size,
      runId: params.runId,
      ownerId: params.ownerId,
      hasProvidedKey: Boolean(params.accessKey),
      providedKeyFingerprint: fingerprint(params.accessKey),
      hasRunKey: Boolean(runKey),
      runKeyFingerprint: fingerprint(runKey),
      runKeyMatches:
        Boolean(params.accessKey) && this.constantTimeEqual(runKey, params.accessKey ?? ""),
      hasOwnerKey: Boolean(ownerKey),
      ownerKeyFingerprint: fingerprint(ownerKey),
      ownerKeyMatches:
        Boolean(params.accessKey) &&
        this.constantTimeEqual(ownerKey, params.accessKey ?? ""),
    };
  }

  private constantTimeEqual(expected: string | undefined, actual: string): boolean {
    if (!expected) return false;

    const expectedBuffer = Buffer.from(expected);
    const actualBuffer = Buffer.from(actual);
    if (expectedBuffer.length !== actualBuffer.length) return false;

    return timingSafeEqual(expectedBuffer, actualBuffer);
  }
}

function fingerprint(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}
