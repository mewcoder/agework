import { describe, expect, it } from "vitest";
import {
  isMetadataRecord,
  runningInstanceMetadata,
  runtimeInstanceDiagnostics,
  statusInstanceMetadata,
  stoppedInstanceMetadata,
} from "./worker-registry-metadata";

describe("worker-registry-metadata", () => {
  it("isMetadataRecord rejects arrays and null", () => {
    expect(isMetadataRecord({})).toBe(true);
    expect(isMetadataRecord([])).toBe(false);
    expect(isMetadataRecord(null)).toBe(false);
    expect(isMetadataRecord("x")).toBe(false);
  });

  it("runningInstanceMetadata carries ownerId/workspaceId and marks statusReason running", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const result = runningInstanceMetadata({
      workspaceId: "ws-1",
      ownerId: "ws-1",
      runtimeInstanceId: "inst-1",
      now,
    });
    expect(result.ownerId).toBe("ws-1");
    expect(result.workspaceId).toBe("ws-1");
    expect(result.statusReason).toBe("running");
    expect(result.runtimeInstanceId).toBe("inst-1");
    expect(result.lastSeenAt).toBe(now.toISOString());
  });

  it("runningInstanceMetadata preserves existing metadata record fields", () => {
    const result = runningInstanceMetadata({
      workspaceId: "ws-1",
      ownerId: "ws-1",
      runtimeInstanceId: "inst-1",
      existing: { customField: "kept" },
    });
    expect(result.customField).toBe("kept");
  });

  it("stoppedInstanceMetadata sets stoppedAt and optional errorMessage", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const result = stoppedInstanceMetadata({
      runtimeType: "sandbox",
      isolationScope: "workspace",
      ownerId: "ws-1",
      reason: "owner_released",
      now,
    });
    expect(result.statusReason).toBe("owner_released");
    expect(result.stoppedAt).toBe(now.toISOString());
    expect(result.errorMessage).toBeUndefined();
  });

  it("statusInstanceMetadata does not set stoppedAt", () => {
    const result = statusInstanceMetadata({
      runtimeType: "sandbox",
      isolationScope: "workspace",
      ownerId: "ws-1",
      reason: "error",
      errorMessage: "boom",
    });
    expect(result.stoppedAt).toBeUndefined();
    expect(result.errorMessage).toBe("boom");
  });

  it("runtimeInstanceDiagnostics extracts known string fields and ignores non-record input", () => {
    expect(runtimeInstanceDiagnostics(null)).toEqual({
      ownerId: undefined,
      workspaceId: undefined,
      statusReason: undefined,
      lastSeenAt: undefined,
      lastStartedAt: undefined,
      stoppedAt: undefined,
      errorMessage: undefined,
      runtimeInstanceId: undefined,
    });
    expect(
      runtimeInstanceDiagnostics({
        ownerId: "ws-1",
        statusReason: "running",
        extra: 1,
      })
    ).toMatchObject({ ownerId: "ws-1", statusReason: "running" });
  });
});
