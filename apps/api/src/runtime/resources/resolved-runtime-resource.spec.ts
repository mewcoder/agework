import { describe, it, expect } from "vitest";
import type { IsolationScope, RuntimePlacement } from "@agework/shared/protocol";
import { resolvedRuntimeResourceFromPlacement } from "./resolved-runtime-resource";

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
