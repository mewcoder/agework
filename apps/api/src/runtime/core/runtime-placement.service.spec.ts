import { describe, it, expect, vi, beforeEach } from "vitest";
import { RuntimePlacementService } from "./runtime-placement.service";
import { ConfigService } from "../../config/config.service";
import { CONTAINER_WORKSPACES_ROOT } from "../../config/defaults";

describe("RuntimePlacementService", () => {
  let mockConfigService: Partial<ConfigService>;
  let service: RuntimePlacementService;

  beforeEach(() => {
    mockConfigService = {
      getDefaultRuntimeType: vi.fn().mockReturnValue("sandbox"),
      getDefaultIsolationScope: vi.fn().mockReturnValue("user"),
      getSandboxEngine: vi.fn().mockReturnValue("docker"),
      getOpenSandboxConfig: vi.fn().mockReturnValue({
        workspaceMountPath: "/workspace",
      }),
    };
    service = new RuntimePlacementService(mockConfigService as ConfigService);
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
      expect(placement.sandboxEngineType).toBe("docker");
      expect(placement.isolationScope).toBe("user");
      expect(placement.hostPath).toBe("/data/users/user-1");
      expect(placement.runtimePath).toBe(`${CONTAINER_WORKSPACES_ROOT}/ws-1`);
      expect(placement.mountTarget).toBe(CONTAINER_WORKSPACES_ROOT);
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

      expect(placement.isolationScope).toBe("workspace");
      expect(placement.hostPath).toBe("/data/users/user-1/ws-1");
      expect(placement.runtimePath).toBe(`${CONTAINER_WORKSPACES_ROOT}/ws-1`);
      expect(placement.mountTarget).toBe(`${CONTAINER_WORKSPACES_ROOT}/ws-1`);
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

    it("still records isolationScope for placement bookkeeping", () => {
      mockConfigService.getDefaultIsolationScope = vi
        .fn()
        .mockReturnValue("user");

      const placement = service.resolveForRun({
        userId: "user-1",
        workspaceId: "ws-1",
        workspaceRootPath: "/data/users/user-1/ws-1",
        userWorkspaceRootPath: "/data/users/user-1",
      });

      expect(placement.isolationScope).toBe("user");
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

    expect(placement.isolationScope).toBe("workspace");
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
