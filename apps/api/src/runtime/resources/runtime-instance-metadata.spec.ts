import { describe, it, expect } from "vitest";
import {
  isMetadataRecord,
  runningInstanceMetadata,
  stoppedInstanceMetadata,
  statusInstanceMetadata,
  runtimeInstanceDiagnostics,
} from "./runtime-instance-metadata";

describe("isMetadataRecord", () => {
  it("returns true for plain objects", () => {
    expect(isMetadataRecord({ a: 1 })).toBe(true);
    expect(isMetadataRecord({})).toBe(true);
  });

  it("returns false for null", () => {
    expect(isMetadataRecord(null)).toBe(false);
  });

  it("returns false for arrays", () => {
    expect(isMetadataRecord([])).toBe(false);
  });

  it("returns false for primitives", () => {
    expect(isMetadataRecord("string")).toBe(false);
    expect(isMetadataRecord(42)).toBe(false);
    expect(isMetadataRecord(undefined)).toBe(false);
  });
});

describe("runningInstanceMetadata", () => {
  it("builds running metadata with required fields", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const result = runningInstanceMetadata({
      placement: { workspaceId: "ws-1" } as never,
      scopeKey: "ws-1",
      runtimeInstanceId: "container-1",
      now,
    });

    expect(result).toMatchObject({
      scopeKey: "ws-1",
      workspaceId: "ws-1",
      statusReason: "running",
      lastSeenAt: "2026-01-01T00:00:00.000Z",
      lastStartedAt: "2026-01-01T00:00:00.000Z",
      runtimeInstanceId: "container-1",
    });
  });

  it("merges existing metadata", () => {
    const result = runningInstanceMetadata({
      placement: { workspaceId: "ws-1" } as never,
      scopeKey: "ws-1",
      runtimeInstanceId: "c-1",
      existing: { customField: "preserved" },
      now: new Date("2026-01-01T00:00:00Z"),
    });
    expect(result.customField).toBe("preserved");
  });

  it("merges additional metadata over existing", () => {
    const result = runningInstanceMetadata({
      placement: { workspaceId: "ws-1" } as never,
      scopeKey: "ws-1",
      runtimeInstanceId: "c-1",
      existing: { key: "old" },
      metadata: { key: "new" },
      now: new Date("2026-01-01T00:00:00Z"),
    });
    expect(result.key).toBe("new");
  });
});

describe("stoppedInstanceMetadata", () => {
  it("builds stopped metadata", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const result = stoppedInstanceMetadata({
      runtimeType: "docker",
      isolationScope: "workspace",
      scopeKey: "ws-1",
      reason: "idle_timeout",
      now,
    });

    expect(result).toMatchObject({
      scopeKey: "ws-1",
      runtimeType: "docker",
      isolationScope: "workspace",
      statusReason: "idle_timeout",
      stoppedAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("includes errorMessage when provided", () => {
    const result = stoppedInstanceMetadata({
      runtimeType: "docker",
      isolationScope: "workspace",
      scopeKey: "ws-1",
      reason: "error",
      errorMessage: "crashed",
      now: new Date(),
    });
    expect(result.errorMessage).toBe("crashed");
  });

  it("omits errorMessage when not provided", () => {
    const result = stoppedInstanceMetadata({
      runtimeType: "docker",
      isolationScope: "workspace",
      scopeKey: "ws-1",
      reason: "stopped",
      now: new Date(),
    });
    expect(result).not.toHaveProperty("errorMessage");
  });
});

describe("statusInstanceMetadata", () => {
  it("builds status metadata", () => {
    const result = statusInstanceMetadata({
      runtimeType: "docker",
      isolationScope: "workspace",
      scopeKey: "ws-1",
      reason: "healthy",
      now: new Date("2026-01-01T00:00:00Z"),
    });
    expect(result.statusReason).toBe("healthy");
    expect(result).not.toHaveProperty("stoppedAt");
  });
});

describe("runtimeInstanceDiagnostics", () => {
  it("extracts known fields from metadata", () => {
    expect(
      runtimeInstanceDiagnostics({
        scopeKey: "ws-1",
        workspaceId: "ws-1",
        statusReason: "running",
        lastSeenAt: "2026-01-01",
        lastStartedAt: "2026-01-01",
        stoppedAt: null,
        errorMessage: "oops",
        runtimeInstanceId: "c-1",
      })
    ).toEqual({
      scopeKey: "ws-1",
      workspaceId: "ws-1",
      statusReason: "running",
      lastSeenAt: "2026-01-01",
      lastStartedAt: "2026-01-01",
      stoppedAt: undefined,
      errorMessage: "oops",
      runtimeInstanceId: "c-1",
    });
  });

  it("returns undefined for missing fields", () => {
    expect(runtimeInstanceDiagnostics(null)).toEqual({
      scopeKey: undefined,
      workspaceId: undefined,
      statusReason: undefined,
      lastSeenAt: undefined,
      lastStartedAt: undefined,
      stoppedAt: undefined,
      errorMessage: undefined,
      runtimeInstanceId: undefined,
    });
  });

  it("returns undefined for non-string fields", () => {
    expect(
      runtimeInstanceDiagnostics({ scopeKey: 42, lastSeenAt: true })
    ).toEqual(
      expect.objectContaining({ scopeKey: undefined, lastSeenAt: undefined })
    );
  });
});
