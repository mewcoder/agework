import { describe, it, expect } from "vitest";
import type { IsolationScope } from "@agework/shared/protocol";
import {
  resolveRuntimeTarget,
  type ResolveRuntimeTargetInput,
  type RuntimeTargetDefaults,
} from "./runtime-resource";
import { CONTAINER_WORKSPACES_ROOT } from "../../config/registry/defaults";

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
    it("hostPath=userRoot, runtimePath under /workspaces/, ownerId=userId", () => {
      const r = resolve();
      expect(r.runtimeType).toBe("sandbox");
      expect(r.hostPath).toBe("/data/users/user-1");
      expect(r.runtimePath).toBe(`${CONTAINER_WORKSPACES_ROOT}/ws-1`);
      expect(r.ownerId).toBe("user-1");
      expect(r.workspaceId).toBe("ws-1");
      expect((r as { sandbox?: unknown }).sandbox).toMatchObject({
        isolationScope: "user",
        mountTarget: CONTAINER_WORKSPACES_ROOT,
        sandboxEngineType: "docker",
      });
    });

    it("different workspaces of the same user get different runtimePaths, same ownerId", () => {
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
      expect(a.ownerId).toBe(b.ownerId); // 同用户共享桶
    });
  });

  describe("sandbox, workspace isolation", () => {
    it("hostPath=workspaceRoot, mountTarget per-workspace, ownerId=workspaceId", () => {
      const r = resolve({ isolationScope: "workspace" });
      expect(r.hostPath).toBe("/data/users/user-1/ws-1");
      expect(r.runtimePath).toBe(`${CONTAINER_WORKSPACES_ROOT}/ws-1`);
      expect(r.ownerId).toBe("ws-1");
      expect((r as { sandbox?: unknown }).sandbox).toMatchObject({
        isolationScope: "workspace",
        mountTarget: `${CONTAINER_WORKSPACES_ROOT}/ws-1`,
      });
    });
  });

  describe("local", () => {
    it("runtimePath === hostPath === workspaceRootPath, no sandbox info, ownerId=workspaceId", () => {
      const r = resolve({ runtimeType: "local" });
      expect(r.runtimeType).toBe("local");
      expect(r.hostPath).toBe("/data/users/user-1/ws-1");
      expect(r.runtimePath).toBe("/data/users/user-1/ws-1");
      expect((r as { sandbox?: unknown }).sandbox).toBeUndefined();
      expect(r.ownerId).toBe("ws-1");
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
