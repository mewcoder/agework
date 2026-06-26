import { describe, it, expect, beforeEach } from "vitest";
import { WorkerAccessService } from "./access.service";

describe("WorkerAccessService", () => {
  let service: WorkerAccessService;

  beforeEach(() => {
    service = new WorkerAccessService();
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

  it("verifies a run using its owner key after registerRun", () => {
    const key = service.issueOwnerKey("owner-1");
    service.registerRun("run-1", key);

    expect(service.verifyAccessKey("run-1", key)).toBe(true);
    expect(service.verifyAccessKey("run-1", "wrong")).toBe(false);
  });

  it("verifies the owner key", () => {
    const key = service.issueOwnerKey("owner-1");

    expect(service.verifyOwnerKey("owner-1", key)).toBe(true);
    expect(service.verifyOwnerKey("owner-1", "wrong")).toBe(false);
  });

  it("revokeOwner invalidates the key and bound runs", () => {
    const key = service.issueOwnerKey("owner-1");
    service.registerRun("run-1", key);
    service.revokeOwner("owner-1");

    expect(service.verifyOwnerKey("owner-1", key)).toBe(false);
    expect(service.verifyAccessKey("run-1", key)).toBe(false);
  });

  describe("runtime instance keys", () => {
    it("issues and verifies a runtime instance key", () => {
      const key = service.issueRuntimeInstanceKey("rr-1", "owner-1");

      expect(service.verifyRuntimeInstanceKey("rr-1", key)).toBe(true);
    });

    it("reuses owner key when owner already has one", () => {
      const ownerKey = service.issueOwnerKey("owner-1");
      const resourceAccessKey = service.issueRuntimeInstanceKey(
        "rr-1",
        "owner-1"
      );

      // Same key works for both endpoints
      expect(resourceAccessKey).toBe(ownerKey);
      expect(service.verifyOwnerKey("owner-1", resourceAccessKey)).toBe(true);
      expect(service.verifyRuntimeInstanceKey("rr-1", ownerKey)).toBe(true);
    });

    it("issues a new key when owner has no owner key", () => {
      const key = service.issueRuntimeInstanceKey("rr-1", "owner-1");

      expect(key).toBeTruthy();
      expect(service.verifyRuntimeInstanceKey("rr-1", key)).toBe(true);
    });

    it("rejects an incorrect runtime instance key", () => {
      service.issueRuntimeInstanceKey("rr-1", "owner-1");

      expect(service.verifyRuntimeInstanceKey("rr-1", "wrong")).toBe(false);
    });

    it("revokes a runtime instance key", () => {
      const key = service.issueRuntimeInstanceKey("rr-1", "owner-1");
      service.revokeRuntimeInstance("rr-1");

      expect(service.verifyRuntimeInstanceKey("rr-1", key)).toBe(false);
    });
  });
});
