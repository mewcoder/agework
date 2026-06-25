import { describe, it, expect } from "vitest";
import type { IsolationScope } from "@agework/shared/protocol";
import {
  resolveRuntimeResource,
  runtimeResourceKey,
  runtimeResourceKeyForOwner,
  type ResolveRuntimeResourceInput,
  type RuntimeResourceDefaults,
} from "./runtime-resource";
import { CONTAINER_WORKSPACES_ROOT } from "../../config/defaults";

const DEFAULTS: RuntimeResourceDefaults = {
  runtimeType: "sandbox",
  isolationScope: "user",
  sandboxEngine: "docker",
};

const BASE: ResolveRuntimeResourceInput = {
  userId: "user-1",
  workspaceId: "ws-1",
  workspaceRootPath: "/data/users/user-1/ws-1",
  userWorkspaceRootPath: "/data/users/user-1",
};

const withInput = (
  overrides: Partial<ResolveRuntimeResourceInput>
): ResolveRuntimeResourceInput => ({ ...BASE, ...overrides });

const resolve = (overrides: Partial<ResolveRuntimeResourceInput> = {}) =>
  resolveRuntimeResource(withInput(overrides), DEFAULTS);

describe("resolveRuntimeResource", () => {
  describe("sandbox, user isolation", () => {
    it("hostPath=userRoot, runtimePath under /workspaces/, resourceKey=userId", () => {
      const r = resolve();
      expect(r.runtimeType).toBe("sandbox");
      expect(r.hostPath).toBe("/data/users/user-1");
      expect(r.runtimePath).toBe(`${CONTAINER_WORKSPACES_ROOT}/ws-1`);
      expect(r.resourceKey).toBe("user-1");
      expect(r.workspaceId).toBe("ws-1");
      expect((r as { sandbox?: unknown }).sandbox).toMatchObject({
        isolationScope: "user",
        mountTarget: CONTAINER_WORKSPACES_ROOT,
        sandboxEngineType: "docker",
      });
    });

    it("different workspaces of the same user get different runtimePaths, same resourceKey", () => {
      const a = resolve({ workspaceId: "ws-a", workspaceRootPath: "/data/users/user-1/ws-a" });
      const b = resolve({ workspaceId: "ws-b", workspaceRootPath: "/data/users/user-1/ws-b" });
      expect(a.runtimePath).toBe(`${CONTAINER_WORKSPACES_ROOT}/ws-a`);
      expect(b.runtimePath).toBe(`${CONTAINER_WORKSPACES_ROOT}/ws-b`);
      expect(a.resourceKey).toBe(b.resourceKey); // 同用户共享桶
    });
  });

  describe("sandbox, workspace isolation", () => {
    it("hostPath=workspaceRoot, mountTarget per-workspace, resourceKey=workspaceId", () => {
      const r = resolve({ isolationScope: "workspace" });
      expect(r.hostPath).toBe("/data/users/user-1/ws-1");
      expect(r.runtimePath).toBe(`${CONTAINER_WORKSPACES_ROOT}/ws-1`);
      expect(r.resourceKey).toBe("ws-1");
      expect((r as { sandbox?: unknown }).sandbox).toMatchObject({
        isolationScope: "workspace",
        mountTarget: `${CONTAINER_WORKSPACES_ROOT}/ws-1`,
      });
    });
  });

  describe("local", () => {
    it("runtimePath === hostPath === workspaceRootPath, no sandbox info, resourceKey=workspaceId", () => {
      const r = resolve({ runtimeType: "local" });
      expect(r.runtimeType).toBe("local");
      expect(r.hostPath).toBe("/data/users/user-1/ws-1");
      expect(r.runtimePath).toBe("/data/users/user-1/ws-1");
      expect((r as { sandbox?: unknown }).sandbox).toBeUndefined();
      expect(r.resourceKey).toBe("ws-1");
    });
  });

  describe("validation", () => {
    it("throws when workspaceRootPath is outside userWorkspaceRootPath (user isolation)", () => {
      expect(() => resolve({ workspaceRootPath: "/data/users/user-2/ws-1" })).toThrow();
    });

    it("throws when workspaceRootPath is relative", () => {
      expect(() => resolve({ workspaceRootPath: "relative/ws-1" })).toThrow();
    });

    it("throws when userWorkspaceRootPath is relative", () => {
      expect(() =>
        resolve({ userWorkspaceRootPath: "relative/users/user-1" })
      ).toThrow();
    });
  });
});

describe("runtimeResourceKey", () => {
  it("user scope → userId, workspace scope → workspaceId", () => {
    expect(runtimeResourceKey("user", "u-1", "ws-1")).toBe("u-1");
    expect(runtimeResourceKey("workspace", "u-1", "ws-1")).toBe("ws-1");
  });

  it("throws on an unknown scope", () => {
    expect(() => runtimeResourceKey("nope" as IsolationScope, "u-1", "ws-1")).toThrow(
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
