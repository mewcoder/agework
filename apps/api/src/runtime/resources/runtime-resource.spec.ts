import { describe, it, expect, vi } from "vitest";
import type { IsolationScope } from "@agework/shared/protocol";
import {
  resolveRuntimeResource,
  runtimeResourceKey,
  runtimeResourceKeyForOwner,
  type ResolveRuntimeResourceInput,
} from "./runtime-resource";
import type { ConfigService } from "../../config/config.service";
import { CONTAINER_WORKSPACES_ROOT } from "../../config/defaults";

function makeConfig(overrides: Partial<ConfigService> = {}): Pick<
  ConfigService,
  "getDefaultRuntimeType" | "getDefaultIsolationScope" | "getSandboxEngine"
> {
  return {
    getDefaultRuntimeType: vi.fn().mockReturnValue("sandbox"),
    getDefaultIsolationScope: vi.fn().mockReturnValue("user"),
    getSandboxEngine: vi.fn().mockReturnValue("docker"),
    ...overrides,
  } as never;
}

const BASE: ResolveRuntimeResourceInput = {
  userId: "user-1",
  workspaceId: "ws-1",
  workspaceRootPath: "/data/users/user-1/ws-1",
  userWorkspaceRootPath: "/data/users/user-1",
};

describe("resolveRuntimeResource", () => {
  describe("sandbox, user isolation (default)", () => {
    it("hostPath=userRoot, runtimePath under /workspaces/, resourceKey=userId", () => {
      const r = resolveRuntimeResource(BASE, makeConfig());
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
      const cfg = makeConfig();
      const a = resolveRuntimeResource(
        { ...BASE, workspaceId: "ws-a", workspaceRootPath: "/data/users/user-1/ws-a" },
        cfg
      );
      const b = resolveRuntimeResource(
        { ...BASE, workspaceId: "ws-b", workspaceRootPath: "/data/users/user-1/ws-b" },
        cfg
      );
      expect(a.runtimePath).toBe(`${CONTAINER_WORKSPACES_ROOT}/ws-a`);
      expect(b.runtimePath).toBe(`${CONTAINER_WORKSPACES_ROOT}/ws-b`);
      expect(a.resourceKey).toBe(b.resourceKey); // 同用户共享桶
    });
  });

  describe("sandbox, workspace isolation", () => {
    it("hostPath=workspaceRoot, mountTarget per-workspace, resourceKey=workspaceId", () => {
      const r = resolveRuntimeResource(
        BASE,
        makeConfig({
          getDefaultIsolationScope: vi.fn().mockReturnValue("workspace"),
        })
      );
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
      const r = resolveRuntimeResource(
        BASE,
        makeConfig({ getDefaultRuntimeType: vi.fn().mockReturnValue("local") })
      );
      expect(r.runtimeType).toBe("local");
      expect(r.hostPath).toBe("/data/users/user-1/ws-1");
      expect(r.runtimePath).toBe("/data/users/user-1/ws-1");
      expect((r as { sandbox?: unknown }).sandbox).toBeUndefined();
      expect(r.resourceKey).toBe("ws-1");
    });
  });

  describe("explicit overrides win over config defaults", () => {
    it("runtimeType", () => {
      const r = resolveRuntimeResource(
        { ...BASE, runtimeType: "local" },
        makeConfig()
      );
      expect(r.runtimeType).toBe("local");
    });

    it("isolationScope", () => {
      const r = resolveRuntimeResource(
        { ...BASE, runtimeType: "sandbox", isolationScope: "workspace" },
        makeConfig()
      );
      expect((r as { sandbox?: { isolationScope?: string } }).sandbox?.isolationScope).toBe("workspace");
    });
  });

  describe("validation", () => {
    it("throws when workspaceRootPath is outside userWorkspaceRootPath (user isolation)", () => {
      expect(() =>
        resolveRuntimeResource(
          { ...BASE, workspaceRootPath: "/data/users/user-2/ws-1" },
          makeConfig()
        )
      ).toThrow();
    });

    it("throws when workspaceRootPath is relative", () => {
      expect(() =>
        resolveRuntimeResource(
          { ...BASE, workspaceRootPath: "relative/ws-1" },
          makeConfig()
        )
      ).toThrow();
    });

    it("throws when userWorkspaceRootPath is relative", () => {
      expect(() =>
        resolveRuntimeResource(
          { ...BASE, userWorkspaceRootPath: "relative/users/user-1" },
          makeConfig()
        )
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
