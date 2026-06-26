import { describe, it, expect, beforeEach } from "vitest";
import { RuntimeInternalAccessService } from "./access.service";

describe("RuntimeInternalAccessService", () => {
  let service: RuntimeInternalAccessService;

  beforeEach(() => {
    service = new RuntimeInternalAccessService();
  });

  it("issues an access key that can be verified for the same run", () => {
    const accessKey = service.issueAccessKey("run-123");

    expect(service.verifyAccessKey("run-123", accessKey)).toBe(true);
  });

  it("rejects an access key for another run", () => {
    const accessKey = service.issueAccessKey("run-123");

    expect(service.verifyAccessKey("run-456", accessKey)).toBe(false);
  });

  it("rejects an incorrect access key", () => {
    service.issueAccessKey("run-123");

    expect(service.verifyAccessKey("run-123", "wrong-access-key")).toBe(false);
  });

  it("revokes access for a run", () => {
    const accessKey = service.issueAccessKey("run-123");

    service.revokeAccess("run-123");

    expect(service.verifyAccessKey("run-123", accessKey)).toBe(false);
  });

  it("replaces the previous access key when issuing again for the same run", () => {
    const first = service.issueAccessKey("run-123");
    const second = service.issueAccessKey("run-123");

    expect(service.verifyAccessKey("run-123", first)).toBe(false);
    expect(service.verifyAccessKey("run-123", second)).toBe(true);
  });

  it("verifies a run using its workspace key after registerRun", () => {
    const key = service.issueWorkspaceKey("ws-1");
    service.registerRun("run-1", key);

    expect(service.verifyAccessKey("run-1", key)).toBe(true);
    expect(service.verifyAccessKey("run-1", "wrong")).toBe(false);
  });

  it("verifies the workspace controls key", () => {
    const key = service.issueWorkspaceKey("ws-1");

    expect(service.verifyWorkspaceKey("ws-1", key)).toBe(true);
    expect(service.verifyWorkspaceKey("ws-1", "wrong")).toBe(false);
  });

  it("revokeWorkspace invalidates the key and bound runs", () => {
    const key = service.issueWorkspaceKey("ws-1");
    service.registerRun("run-1", key);
    service.revokeWorkspace("ws-1");

    expect(service.verifyWorkspaceKey("ws-1", key)).toBe(false);
    expect(service.verifyAccessKey("run-1", key)).toBe(false);
  });

  describe("runtime resource keys", () => {
    it("issues and verifies a runtime resource key", () => {
      const key = service.issueRuntimeInstanceKey("rr-1", "ws-1", "sandbox");

      expect(service.verifyRuntimeInstanceKey("rr-1", key)).toBe(true);
    });

    it("reuses workspace key when scopeKey already has one", () => {
      const workspaceKey = service.issueWorkspaceKey("ws-1");
      const resourceAccessKey = service.issueRuntimeInstanceKey(
        "rr-1",
        "ws-1",
        "sandbox"
      );

      // Same key works for both endpoints
      expect(resourceAccessKey).toBe(workspaceKey);
      expect(service.verifyWorkspaceKey("ws-1", resourceAccessKey)).toBe(true);
      expect(service.verifyRuntimeInstanceKey("rr-1", workspaceKey)).toBe(true);
    });

    it("issues a new key when scopeKey has no workspace key", () => {
      const key = service.issueRuntimeInstanceKey("rr-1", "ws-1", "sandbox");

      expect(key).toBeTruthy();
      expect(service.verifyRuntimeInstanceKey("rr-1", key)).toBe(true);
    });

    it("rejects an incorrect runtime resource key", () => {
      service.issueRuntimeInstanceKey("rr-1", "ws-1", "sandbox");

      expect(service.verifyRuntimeInstanceKey("rr-1", "wrong")).toBe(false);
    });

    it("returns scopeKey for runtime resource", () => {
      service.issueRuntimeInstanceKey("rr-1", "ws-1", "sandbox");

      expect(service.getScopeKeyForRuntimeInstance("rr-1")).toBe("ws-1");
      expect(service.getRuntimeTypeForRuntimeInstance("rr-1")).toBe("sandbox");
    });

    it("returns undefined for unknown runtime resource scopeKey", () => {
      expect(
        service.getScopeKeyForRuntimeInstance("nonexistent")
      ).toBeUndefined();
    });

    it("revokes a runtime resource key", () => {
      const key = service.issueRuntimeInstanceKey("rr-1", "ws-1", "sandbox");
      service.revokeRuntimeInstance("rr-1");

      expect(service.verifyRuntimeInstanceKey("rr-1", key)).toBe(false);
      expect(service.getScopeKeyForRuntimeInstance("rr-1")).toBeUndefined();
      expect(service.getRuntimeTypeForRuntimeInstance("rr-1")).toBeUndefined();
    });
  });
});
