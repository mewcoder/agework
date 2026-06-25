import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SandboxRuntimePlacement } from "@agework/shared/protocol";
import { RuntimePlacementPolicy } from "./runtime-placement.policy";
import { ConfigService } from "../../../config/config.service";
import { CONTAINER_WORKSPACES_ROOT } from "../../../config/defaults";

describe("RuntimePlacementPolicy", () => {
  let mockConfigService: Partial<ConfigService>;
  let service: RuntimePlacementPolicy;

  beforeEach(() => {
    mockConfigService = {
      getDefaultRuntimeType: vi.fn().mockReturnValue("sandbox"),
      getDefaultIsolationScope: vi.fn().mockReturnValue("user"),
      getSandboxEngine: vi.fn().mockReturnValue("docker"),
      getOpenSandboxConfig: vi.fn().mockReturnValue({
        workspaceMountPath: "/workspace",
      }),
    };
    service = new RuntimePlacementPolicy(mockConfigService as ConfigService);
  });

  describe("non-local runtime, user isolation scope", () => {
    it("resolves hostPath=userWorkspaceRootPath and runtimePath under /workspaces/", () => {
      const placement = service.resolveForRun({
        userId: "user-1",
        workspaceId: "ws-1",
        workspaceRootPath: "/data/users/user-1/ws-1",
        userWorkspaceRootPath: "/data/users/user-1",
      });

      expect(placement.runtimeType).toBe("sandbox");
      expect((placement as SandboxRuntimePlacement).sandbox.sandboxEngineType).toBe("docker");
      expect((placement as SandboxRuntimePlacement).sandbox.isolationScope).toBe("user");
      expect(placement.hostPath).toBe("/data/users/user-1");
      expect(placement.runtimePath).toBe(`${CONTAINER_WORKSPACES_ROOT}/ws-1`);
      expect((placement as SandboxRuntimePlacement).sandbox.mountTarget).toBe(CONTAINER_WORKSPACES_ROOT);
    });

    it("resolves different runtimePaths for different workspaces of the same user", () => {
      const placementA = service.resolveForRun({
        userId: "user-1",
        workspaceId: "ws-a",
        workspaceRootPath: "/data/users/user-1/ws-a",
        userWorkspaceRootPath: "/data/users/user-1",
      });
      const placementB = service.resolveForRun({
        userId: "user-1",
        workspaceId: "ws-b",
        workspaceRootPath: "/data/users/user-1/ws-b",
        userWorkspaceRootPath: "/data/users/user-1",
      });

      expect(placementA.runtimePath).not.toBe(placementB.runtimePath);
      expect(placementA.runtimePath).toBe(`${CONTAINER_WORKSPACES_ROOT}/ws-a`);
      expect(placementB.runtimePath).toBe(`${CONTAINER_WORKSPACES_ROOT}/ws-b`);
    });
  });

  describe("non-local runtime, workspace isolation scope", () => {
    beforeEach(() => {
      mockConfigService.getDefaultIsolationScope = vi
        .fn()
        .mockReturnValue("workspace");
    });

    it("resolves hostPath=workspaceRootPath and runtimePath under the workspace mount", () => {
      const placement = service.resolveForRun({
        userId: "user-1",
        workspaceId: "ws-1",
        workspaceRootPath: "/data/users/user-1/ws-1",
        userWorkspaceRootPath: "/data/users/user-1",
      });

      expect((placement as SandboxRuntimePlacement).sandbox.isolationScope).toBe("workspace");
      expect(placement.hostPath).toBe("/data/users/user-1/ws-1");
      expect(placement.runtimePath).toBe(`${CONTAINER_WORKSPACES_ROOT}/ws-1`);
      expect((placement as SandboxRuntimePlacement).sandbox.mountTarget).toBe(`${CONTAINER_WORKSPACES_ROOT}/ws-1`);
    });
  });

  describe("local runtime", () => {
    beforeEach(() => {
      mockConfigService.getDefaultRuntimeType = vi
        .fn()
        .mockReturnValue("local");
    });

    it("runtimePath === hostPath === workspaceRootPath regardless of isolation scope", () => {
      for (const scope of ["user", "workspace"] as const) {
        mockConfigService.getDefaultIsolationScope = vi
          .fn()
          .mockReturnValue(scope);

        const placement = service.resolveForRun({
          userId: "user-1",
          workspaceId: "ws-1",
          workspaceRootPath: "/data/users/user-1/ws-1",
          userWorkspaceRootPath: "/data/users/user-1",
        });

        expect(placement.runtimeType).toBe("local");
        expect(placement.runtimePath).toBe("/data/users/user-1/ws-1");
        expect(placement.hostPath).toBe("/data/users/user-1/ws-1");
        expect(placement.runtimePath).toBe(placement.hostPath);
      }
    });

    it("does not carry sandbox info (local has no container isolation)", () => {
      mockConfigService.getDefaultIsolationScope = vi
        .fn()
        .mockReturnValue("user");

      const placement = service.resolveForRun({
        userId: "user-1",
        workspaceId: "ws-1",
        workspaceRootPath: "/data/users/user-1/ws-1",
        userWorkspaceRootPath: "/data/users/user-1",
      });

      expect((placement as any).sandbox).toBeUndefined();
    });
  });

  it("uses the workspace runtimeType when provided", () => {
    mockConfigService.getDefaultIsolationScope = vi
      .fn()
      .mockReturnValue("workspace");

    const placement = service.resolveForRun({
      userId: "user-1",
      workspaceId: "ws-1",
      workspaceRootPath: "/data/users/user-1/ws-1",
      userWorkspaceRootPath: "/data/users/user-1",
      runtimeType: "local",
    });

    expect(placement.runtimeType).toBe("local");
    expect(placement.runtimePath).toBe("/data/users/user-1/ws-1");
  });

  it("uses the workspace isolationScope when provided", () => {
    mockConfigService.getDefaultIsolationScope = vi
      .fn()
      .mockReturnValue("user");

    const placement = service.resolveForRun({
      userId: "user-1",
      workspaceId: "ws-1",
      workspaceRootPath: "/data/users/user-1/ws-1",
      userWorkspaceRootPath: "/data/users/user-1",
      runtimeType: "sandbox",
      isolationScope: "workspace",
    });

    expect((placement as SandboxRuntimePlacement).sandbox.isolationScope).toBe("workspace");
    expect(placement.hostPath).toBe("/data/users/user-1/ws-1");
  });

  describe("validation", () => {
    it("throws when workspaceRootPath is outside userWorkspaceRootPath", () => {
      expect(() =>
        service.resolveForRun({
          userId: "user-1",
          workspaceId: "ws-1",
          workspaceRootPath: "/data/users/user-2/ws-1",
          userWorkspaceRootPath: "/data/users/user-1",
        })
      ).toThrow();
    });

    it("throws when workspaceRootPath is a relative path", () => {
      expect(() =>
        service.resolveForRun({
          userId: "user-1",
          workspaceId: "ws-1",
          workspaceRootPath: "relative/ws-1",
          userWorkspaceRootPath: "/data/users/user-1",
        })
      ).toThrow();
    });

    it("throws when userWorkspaceRootPath is a relative path", () => {
      expect(() =>
        service.resolveForRun({
          userId: "user-1",
          workspaceId: "ws-1",
          workspaceRootPath: "/data/users/user-1/ws-1",
          userWorkspaceRootPath: "relative/users/user-1",
        })
      ).toThrow();
    });
  });
});
