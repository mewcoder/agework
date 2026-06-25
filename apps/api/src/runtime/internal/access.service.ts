import { Injectable } from "@nestjs/common";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const ACCESS_KEY_BYTES = 32;

@Injectable()
export class RuntimeInternalAccessService {
  private readonly accessKeys = new Map<string, string>();
  private readonly workspaceKeys = new Map<string, string>();
  /** RuntimeResource.id → accessKey */
  private readonly runtimeResourceKeys = new Map<string, string>();
  /** RuntimeResource.id → resourceKey (用于 heartbeat 时查找 provider 内部 key) */
  private readonly runtimeResourceScopeKeys = new Map<string, string>();
  /** RuntimeResource.id → runtimeType */
  private readonly runtimeResourceRuntimeTypes = new Map<string, string>();

  /**
   * 为单个 run 签发内部访问 key。
   * Worker 用它访问 /internal/runs/*；run 清理时可撤销。
   */
  issueAccessKey(runId: string): string {
    const accessKey = randomBytes(ACCESS_KEY_BYTES).toString("base64url");
    this.accessKeys.set(runId, accessKey);
    return accessKey;
  }

  /**
   * 为 workspace 签发内部访问 key。
   * Worker 用同一个 key 访问 per-run 端点和 workspace controls 端点。
   */
  issueWorkspaceKey(workspaceId: string): string {
    const accessKey = randomBytes(ACCESS_KEY_BYTES).toString("base64url");
    this.workspaceKeys.set(workspaceId, accessKey);
    return accessKey;
  }

  /** 把某个 run 绑定到 workspace key，使 per-run 端点用 workspace key 即可通过。 */
  registerRun(runId: string, workspaceKey: string): void {
    this.accessKeys.set(runId, workspaceKey);
  }

  verifyAccessKey(runId: string, accessKey: string): boolean {
    return this.constantTimeEqual(this.accessKeys.get(runId), accessKey);
  }

  verifyWorkspaceKey(workspaceId: string, accessKey: string): boolean {
    return this.constantTimeEqual(this.workspaceKeys.get(workspaceId), accessKey);
  }

  revokeAccess(runId: string): void {
    this.accessKeys.delete(runId);
  }

  revokeWorkspace(workspaceId: string): void {
    const key = this.workspaceKeys.get(workspaceId);
    this.workspaceKeys.delete(workspaceId);
    if (key) {
      for (const [runId, k] of this.accessKeys) {
        if (k === key) this.accessKeys.delete(runId);
      }
    }
  }

  /**
   * 为 RuntimeResource 签发内部访问 key。
   * 复用 resourceKey 对应的 workspaceKey，使同一个 key 可同时用于
   * /internal/workspaces/:workspaceId 和 /internal/runtimes/:runtimeResourceId。
   */
  issueRuntimeResourceKey(
    runtimeResourceId: string,
    resourceKey: string,
    runtimeType: string
  ): string {
    const existingKey = this.workspaceKeys.get(resourceKey);
    if (existingKey) {
      this.runtimeResourceKeys.set(runtimeResourceId, existingKey);
    } else {
      const accessKey = randomBytes(ACCESS_KEY_BYTES).toString("base64url");
      this.runtimeResourceKeys.set(runtimeResourceId, accessKey);
    }
    this.runtimeResourceScopeKeys.set(runtimeResourceId, resourceKey);
    this.runtimeResourceRuntimeTypes.set(runtimeResourceId, runtimeType);
    return this.runtimeResourceKeys.get(runtimeResourceId)!;
  }

  verifyRuntimeResourceKey(runtimeResourceId: string, accessKey: string): boolean {
    return this.constantTimeEqual(this.runtimeResourceKeys.get(runtimeResourceId), accessKey);
  }

  /** 获取 RuntimeResource.id 对应的 resourceKey（用于 heartbeat 等）。 */
  getResourceKeyForRuntimeResource(runtimeResourceId: string): string | undefined {
    return this.runtimeResourceScopeKeys.get(runtimeResourceId);
  }

  getRuntimeTypeForRuntimeResource(runtimeResourceId: string): string | undefined {
    return this.runtimeResourceRuntimeTypes.get(runtimeResourceId);
  }

  revokeRuntimeResource(runtimeResourceId: string): void {
    this.runtimeResourceKeys.delete(runtimeResourceId);
    this.runtimeResourceScopeKeys.delete(runtimeResourceId);
    this.runtimeResourceRuntimeTypes.delete(runtimeResourceId);
  }

  diagnostics(params: {
    runId?: string;
    workspaceId?: string;
    runtimeResourceId?: string;
    accessKey?: string;
  }): Record<string, unknown> {
    const runKey = params.runId
      ? this.accessKeys.get(params.runId)
      : undefined;
    const workspaceKey = params.workspaceId
      ? this.workspaceKeys.get(params.workspaceId)
      : undefined;
    const runtimeResourceKey = params.runtimeResourceId
      ? this.runtimeResourceKeys.get(params.runtimeResourceId)
      : undefined;

    return {
      accessKeyCount: this.accessKeys.size,
      workspaceKeyCount: this.workspaceKeys.size,
      runtimeResourceKeyCount: this.runtimeResourceKeys.size,
      runId: params.runId,
      workspaceId: params.workspaceId,
      runtimeResourceId: params.runtimeResourceId,
      hasProvidedKey: Boolean(params.accessKey),
      providedKeyFingerprint: fingerprint(params.accessKey),
      hasRunKey: Boolean(runKey),
      runKeyFingerprint: fingerprint(runKey),
      runKeyMatches:
        Boolean(params.accessKey) && this.constantTimeEqual(runKey, params.accessKey ?? ""),
      hasWorkspaceKey: Boolean(workspaceKey),
      workspaceKeyFingerprint: fingerprint(workspaceKey),
      workspaceKeyMatches:
        Boolean(params.accessKey) &&
        this.constantTimeEqual(workspaceKey, params.accessKey ?? ""),
      hasRuntimeResourceKey: Boolean(runtimeResourceKey),
      runtimeResourceKeyFingerprint: fingerprint(runtimeResourceKey),
      runtimeResourceKeyMatches:
        Boolean(params.accessKey) &&
        this.constantTimeEqual(runtimeResourceKey, params.accessKey ?? ""),
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
