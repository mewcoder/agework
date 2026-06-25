import { describe, it, expect } from "vitest";
import type { IsolationScope, RuntimePlacement } from "@agework/shared/protocol";
import {
  resolvedRuntimeResourceFromPlacement,
  runtimeResourceKey,
  runtimeResourceKeyForOwner,
} from "./resolved-runtime-resource";

describe("runtimeResourceKey", () => {
  it("user scope → userId, workspace scope → workspaceId", () => {
    expect(runtimeResourceKey("user", "u-1", "ws-1")).toBe("u-1");
    expect(runtimeResourceKey("workspace", "u-1", "ws-1")).toBe("ws-1");
  });

  it("throws on an unknown scope", () => {
    expect(() => runtimeResourceKey("nope", "u-1", "ws-1")).toThrow(
      "Unknown runtime isolation scope: nope"
    );
  });
});

describe("runtimeResourceKeyForOwner", () => {
  it("user scope uses ownerUserId", () => {
    expect(
      runtimeResourceKeyForOwner({
        isolationScope: "user",
        ownerUserId: "u-1",
        ownerWorkspaceId: null,
      })
    ).toBe("u-1");
  });

  it("workspace scope uses ownerWorkspaceId", () => {
    expect(
      runtimeResourceKeyForOwner({
        isolationScope: "workspace",
        ownerUserId: "u-1",
        ownerWorkspaceId: "ws-1",
      })
    ).toBe("ws-1");
  });

  it("throws when workspace scope is missing ownerWorkspaceId", () => {
    expect(() =>
      runtimeResourceKeyForOwner({
        isolationScope: "workspace",
        ownerUserId: "u-1",
        ownerWorkspaceId: null,
      })
    ).toThrow("Runtime resource ownerWorkspaceId is required");
  });

  it("throws on an unknown scope", () => {
    expect(() =>
      runtimeResourceKeyForOwner({
        isolationScope: "weird",
        ownerUserId: "u-1",
        ownerWorkspaceId: "ws-1",
      })
    ).toThrow("Unknown runtime isolation scope: weird");
  });
});

const sandbox = (
  isolationScope: IsolationScope,
  overrides: Partial<RuntimePlacement> = {}
): RuntimePlacement =>
  ({
    runtimeType: "sandbox",
    userId: "user-1",
    workspaceId: "ws-1",
    hostPath: "/ws",
    runtimePath: "/ws",
    sandbox: { isolationScope, mountTarget: "/ws", sandboxEngineType: "docker" },
    ...overrides,
  }) as RuntimePlacement;

const local = (overrides: Partial<RuntimePlacement> = {}): RuntimePlacement =>
  ({
    runtimeType: "local",
    userId: "user-1",
    workspaceId: "ws-1",
    hostPath: "/ws",
    runtimePath: "/ws",
    ...overrides,
  }) as RuntimePlacement;

describe("resolvedRuntimeResourceFromPlacement", () => {
  it("local uses workspaceId as resourceKey and embeds the placement", () => {
    const placement = local();
    expect(resolvedRuntimeResourceFromPlacement(placement)).toEqual({
      runtimeType: "local",
      resourceKey: "ws-1",
      workspaceId: "ws-1",
      placement,
    });
  });

  it("sandbox user isolation uses userId as resourceKey", () => {
    expect(
      resolvedRuntimeResourceFromPlacement(sandbox("user")).resourceKey
    ).toBe("user-1");
  });

  it("sandbox workspace isolation uses workspaceId as resourceKey", () => {
    expect(
      resolvedRuntimeResourceFromPlacement(sandbox("workspace")).resourceKey
    ).toBe("ws-1");
  });

  it("throws on an unknown isolation scope", () => {
    expect(() =>
      resolvedRuntimeResourceFromPlacement(
        sandbox("unknown" as IsolationScope)
      )
    ).toThrow("Unknown runtime isolation scope: unknown");
  });

  it("throws when runtimeType is missing", () => {
    expect(() =>
      resolvedRuntimeResourceFromPlacement(local({ runtimeType: "" } as never))
    ).toThrow("Runtime placement runtimeType is required");
  });

  it("throws when userId is missing under user isolation", () => {
    expect(() =>
      resolvedRuntimeResourceFromPlacement(sandbox("user", { userId: "" }))
    ).toThrow("Runtime placement userId is required");
  });

  it("throws when workspaceId is missing", () => {
    expect(() =>
      resolvedRuntimeResourceFromPlacement(sandbox("workspace", { workspaceId: "" }))
    ).toThrow("Runtime placement workspaceId is required");
  });
});
