import { describe, it, expect } from "vitest";
import type { IsolationScope } from "@agework/shared/protocol";
import {
  resolveRuntimeTarget,
  runtimeScopeKey,
  runtimeScopeKeyForOwner,
  type ResolveRuntimeTargetInput,
  type RuntimeTargetDefaults,
} from "./runtime-resource";
import { CONTAINER_WORKSPACES_ROOT } from "../../config/defaults";

const DEFAULTS: RuntimeTargetDefaults = {
  runtimeType: "sandbox",
  isolationScope: "user",
  sandboxEngine: "docker",
};

const BASE: ResolveRuntimeTargetInput = {
  userId: "user-1",
  workspaceId: "ws-1",
  workspaceRootPath: "/data/users/user-1/ws-1",
  userWorkspaceRootPath: "/data/users/user-1",
};

const withInput = (
  overrides: Partial<ResolveRuntimeTargetInput>
): ResolveRuntimeTargetInput => ({ ...BASE, ...overrides });

const resolve = (overrides: Partial<ResolveRuntimeTargetInput> = {}) =>
  resolveRuntimeTarget(withInput(overrides), DEFAULTS);

describe("resolveRuntimeTarget", () => {
  describe("sandbox, user isolation", () => {
    it("hostPath=userRoot, runtimePath under /workspaces/, scopeKey=userId", () => {
      const r = resolve();
      expect(r.runtimeType).toBe("sandbox");
      expect(r.hostPath).toBe("/data/users/user-1");
      expect(r.runtimePath).toBe(`${CONTAINER_WORKSPACES_ROOT}/ws-1`);
      expect(r.scopeKey).toBe("user-1");
      expect(r.workspaceId).toBe("ws-1");
      expect((r as { sandbox?: unknown }).sandbox).toMatchObject({
        isolationScope: "user",
        mountTarget: CONTAINER_WORKSPACES_ROOT,
        sandboxEngineType: "docker",
      });
    });

    it("different workspaces of the same user get different runtimePaths, same scopeKey", () => {
      const a = resolve({
        workspaceId: "ws-a",
        workspaceRootPath: "/data/users/user-1/ws-a",
      });
      const b = resolve({
        workspaceId: "ws-b",
        workspaceRootPath: "/data/users/user-1/ws-b",
      });
      expect(a.runtimePath).toBe(`${CONTAINER_WORKSPACES_ROOT}/ws-a`);
      expect(b.runtimePath).toBe(`${CONTAINER_WORKSPACES_ROOT}/ws-b`);
      expect(a.scopeKey).toBe(b.scopeKey); // 同用户共享桶
    });
  });

  describe("sandbox, workspace isolation", () => {
    it("hostPath=workspaceRoot, mountTarget per-workspace, scopeKey=workspaceId", () => {
      const r = resolve({ isolationScope: "workspace" });
      expect(r.hostPath).toBe("/data/users/user-1/ws-1");
      expect(r.runtimePath).toBe(`${CONTAINER_WORKSPACES_ROOT}/ws-1`);
      expect(r.scopeKey).toBe("ws-1");
      expect((r as { sandbox?: unknown }).sandbox).toMatchObject({
        isolationScope: "workspace",
        mountTarget: `${CONTAINER_WORKSPACES_ROOT}/ws-1`,
      });
    });
  });

  describe("local", () => {
    it("runtimePath === hostPath === workspaceRootPath, no sandbox info, scopeKey=workspaceId", () => {
      const r = resolve({ runtimeType: "local" });
      expect(r.runtimeType).toBe("local");
      expect(r.hostPath).toBe("/data/users/user-1/ws-1");
      expect(r.runtimePath).toBe("/data/users/user-1/ws-1");
      expect((r as { sandbox?: unknown }).sandbox).toBeUndefined();
      expect(r.scopeKey).toBe("ws-1");
    });
  });

  describe("validation", () => {
    it("throws when workspaceRootPath is outside userWorkspaceRootPath (user isolation)", () => {
      expect(() =>
        resolve({ workspaceRootPath: "/data/users/user-2/ws-1" })
      ).toThrow();
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

describe("runtimeScopeKey", () => {
  it("user scope → userId, workspace scope → workspaceId", () => {
    expect(runtimeScopeKey("user", "u-1", "ws-1")).toBe("u-1");
    expect(runtimeScopeKey("workspace", "u-1", "ws-1")).toBe("ws-1");
  });

  it("throws on an unknown scope", () => {
    expect(() => runtimeScopeKey("nope", "u-1", "ws-1")).toThrow(
      "Unknown runtime isolation scope: nope"
    );
  });
});

describe("runtimeScopeKeyForOwner", () => {
  it("user scope uses ownerUserId", () => {
    expect(
      runtimeScopeKeyForOwner({
        isolationScope: "user",
        ownerUserId: "u-1",
        ownerWorkspaceId: null,
      })
    ).toBe("u-1");
  });

  it("workspace scope uses ownerWorkspaceId", () => {
    expect(
      runtimeScopeKeyForOwner({
        isolationScope: "workspace",
        ownerUserId: "u-1",
        ownerWorkspaceId: "ws-1",
      })
    ).toBe("ws-1");
  });

  it("throws when workspace scope is missing ownerWorkspaceId", () => {
    expect(() =>
      runtimeScopeKeyForOwner({
        isolationScope: "workspace",
        ownerUserId: "u-1",
        ownerWorkspaceId: null,
      })
    ).toThrow("Runtime resource ownerWorkspaceId is required");
  });

  it("throws on an unknown scope", () => {
    expect(() =>
      runtimeScopeKeyForOwner({
        isolationScope: "weird",
        ownerUserId: "u-1",
        ownerWorkspaceId: "ws-1",
      })
    ).toThrow("Unknown runtime isolation scope: weird");
  });
});
