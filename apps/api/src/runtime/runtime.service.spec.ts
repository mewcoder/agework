import { describe, it, expect, vi, beforeEach } from "vitest";
import { RuntimeService } from "./runtime.service";
import { RuntimeProviderRegistry } from "./providers/provider-registry";
import { ConfigService } from "../config/config.service";
import { CONTAINER_WORKSPACES_ROOT } from "../config/defaults";
import type { SandboxRuntimePlacement } from "@agework/shared/protocol";

const USER_INPUT = {
  userId: "user-1",
  workspaceId: "ws-1",
  workspaceRootPath: "/data/users/user-1/ws-1",
  userWorkspaceRootPath: "/data/users/user-1",
};

describe("RuntimeService", () => {
  let configService: Partial<ConfigService>;
  let providerRegistry: Partial<RuntimeProviderRegistry>;
  let provider: {
    type: string;
    heartbeatRuntimeResource: ReturnType<typeof vi.fn>;
    shutdownRuntimeResource: ReturnType<typeof vi.fn>;
  };
  let service: RuntimeService;

  beforeEach(() => {
    provider = {
      type: "local",
      heartbeatRuntimeResource: vi.fn(),
      shutdownRuntimeResource: vi.fn(),
    };
    configService = {
      getDefaultRuntimeType: vi.fn().mockReturnValue("sandbox"),
      getDefaultIsolationScope: vi.fn().mockReturnValue("user"),
      getSandboxEngine: vi.fn().mockReturnValue("docker"),
    };
    providerRegistry = {
      resolve: vi.fn().mockReturnValue(provider),
      all: vi.fn().mockReturnValue([provider]),
    };
    service = new RuntimeService(
      configService as ConfigService,
      providerRegistry as RuntimeProviderRegistry
    );
  });

  // resolveRuntimeResource = resolvePlacement (path/isolation policy) + 资源身份计算
  describe("resolveRuntimeResource — sandbox, user isolation", () => {
    it("hostPath=userRoot, runtimePath under /workspaces/, resourceKey=userId", () => {
      const result = service.resolveRuntimeResource(USER_INPUT);
      const placement = result.placement as SandboxRuntimePlacement;

      expect(placement.runtimeType).toBe("sandbox");
      expect(placement.sandbox.sandboxEngineType).toBe("docker");
      expect(placement.sandbox.isolationScope).toBe("user");
      expect(placement.hostPath).toBe("/data/users/user-1");
      expect(placement.runtimePath).toBe(`${CONTAINER_WORKSPACES_ROOT}/ws-1`);
      expect(placement.sandbox.mountTarget).toBe(CONTAINER_WORKSPACES_ROOT);
      // user isolation → resourceKey 用 userId（容器按用户复用）
      expect(result.resourceKey).toBe("user-1");
      expect(result.workspaceId).toBe("ws-1");
    });

    it("different workspaces of the same user resolve to different runtimePaths", () => {
      const a = service.resolveRuntimeResource({
        ...USER_INPUT,
        workspaceId: "ws-a",
        workspaceRootPath: "/data/users/user-1/ws-a",
      });
      const b = service.resolveRuntimeResource({
        ...USER_INPUT,
        workspaceId: "ws-b",
        workspaceRootPath: "/data/users/user-1/ws-b",
      });

      expect(a.placement.runtimePath).toBe(`${CONTAINER_WORKSPACES_ROOT}/ws-a`);
      expect(b.placement.runtimePath).toBe(`${CONTAINER_WORKSPACES_ROOT}/ws-b`);
      expect(a.placement.runtimePath).not.toBe(b.placement.runtimePath);
    });
  });

  describe("resolveRuntimeResource — sandbox, workspace isolation", () => {
    beforeEach(() => {
      configService.getDefaultIsolationScope = vi
        .fn()
        .mockReturnValue("workspace");
    });

    it("hostPath=workspaceRoot, mountTarget per-workspace, resourceKey=workspaceId", () => {
      const result = service.resolveRuntimeResource(USER_INPUT);
      const placement = result.placement as SandboxRuntimePlacement;

      expect(placement.sandbox.isolationScope).toBe("workspace");
      expect(placement.hostPath).toBe("/data/users/user-1/ws-1");
      expect(placement.runtimePath).toBe(`${CONTAINER_WORKSPACES_ROOT}/ws-1`);
      expect(placement.sandbox.mountTarget).toBe(
        `${CONTAINER_WORKSPACES_ROOT}/ws-1`
      );
      // workspace isolation → resourceKey 用 workspaceId
      expect(result.resourceKey).toBe("ws-1");
    });
  });

  describe("resolveRuntimeResource — local", () => {
    beforeEach(() => {
      configService.getDefaultRuntimeType = vi.fn().mockReturnValue("local");
    });

    it("runtimePath === hostPath === workspaceRootPath regardless of scope", () => {
      for (const scope of ["user", "workspace"] as const) {
        configService.getDefaultIsolationScope = vi.fn().mockReturnValue(scope);
        const { placement } = service.resolveRuntimeResource(USER_INPUT);
        expect(placement.runtimeType).toBe("local");
        expect(placement.runtimePath).toBe("/data/users/user-1/ws-1");
        expect(placement.hostPath).toBe("/data/users/user-1/ws-1");
      }
    });

    it("does not carry sandbox info and uses workspaceId as resourceKey", () => {
      const result = service.resolveRuntimeResource(USER_INPUT);
      expect(
        (result.placement as { sandbox?: unknown }).sandbox
      ).toBeUndefined();
      expect(result.resourceKey).toBe("ws-1");
    });
  });

  describe("resolveRuntimeResource — explicit overrides", () => {
    it("uses the provided runtimeType over the config default", () => {
      const { placement } = service.resolveRuntimeResource({
        ...USER_INPUT,
        runtimeType: "local",
      });
      expect(placement.runtimeType).toBe("local");
      expect(placement.runtimePath).toBe("/data/users/user-1/ws-1");
    });

    it("uses the provided isolationScope over the config default", () => {
      const result = service.resolveRuntimeResource({
        ...USER_INPUT,
        runtimeType: "sandbox",
        isolationScope: "workspace",
      });
      expect(
        (result.placement as SandboxRuntimePlacement).sandbox.isolationScope
      ).toBe("workspace");
      expect(result.placement.hostPath).toBe("/data/users/user-1/ws-1");
    });
  });

  describe("resolveRuntimeResource — validation", () => {
    it("throws when workspaceRootPath is outside userWorkspaceRootPath (user isolation)", () => {
      expect(() =>
        service.resolveRuntimeResource({
          ...USER_INPUT,
          workspaceRootPath: "/data/users/user-2/ws-1",
        })
      ).toThrow();
    });

    it("throws when workspaceRootPath is relative", () => {
      expect(() =>
        service.resolveRuntimeResource({
          ...USER_INPUT,
          workspaceRootPath: "relative/ws-1",
        })
      ).toThrow();
    });

    it("throws when userWorkspaceRootPath is relative", () => {
      expect(() =>
        service.resolveRuntimeResource({
          ...USER_INPUT,
          userWorkspaceRootPath: "relative/users/user-1",
        })
      ).toThrow();
    });
  });

  describe("runtime resource lifecycle dispatch", () => {
    it("heartbeatRuntimeResource broadcasts to all providers by resource key", () => {
      service.heartbeatRuntimeResource("ws-1");
      expect(providerRegistry.all).toHaveBeenCalled();
      expect(provider.heartbeatRuntimeResource).toHaveBeenCalledWith("ws-1");
    });

    it("shutdownRuntimeResource dispatches to the resolved provider by type", () => {
      service.shutdownRuntimeResource("sandbox", "ws-1");
      expect(providerRegistry.resolve).toHaveBeenCalledWith("sandbox");
      expect(provider.shutdownRuntimeResource).toHaveBeenCalledWith("ws-1");
    });
  });
});
