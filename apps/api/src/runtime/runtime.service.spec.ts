import { describe, it, expect, vi, beforeEach } from "vitest";
import { RuntimeService } from "./runtime.service";
import { RuntimeProviderRegistry } from "./providers/provider-registry";
import { ConfigService } from "../config/config.service";
import type { RuntimeProvider } from "./providers/provider-contracts";

describe("RuntimeService", () => {
  let configService: Partial<ConfigService>;
  let providerRegistry: RuntimeProviderRegistry;
  let resolveSpy: ReturnType<typeof vi.spyOn>;
  let sandboxProvider: RuntimeProvider;
  let shutdownRuntimeInstance: ReturnType<typeof vi.fn>;
  let service: RuntimeService;

  beforeEach(() => {
    shutdownRuntimeInstance = vi.fn((_ownerId: string) => undefined);
    sandboxProvider = {
      type: "sandbox",
      recoverOrphan: vi.fn(async (_runtimeInstanceId: string) => undefined),
      shutdownRuntimeInstance: shutdownRuntimeInstance as (ownerId: string) => void,
    };
    configService = {
      getDefaultRuntimeType: vi.fn().mockReturnValue("local"),
      getDefaultIsolationScope: vi.fn().mockReturnValue("user"),
      getSandboxEngine: vi.fn().mockReturnValue("docker"),
    };
    providerRegistry = new RuntimeProviderRegistry([sandboxProvider]);
    resolveSpy = vi.spyOn(providerRegistry, "resolve");
    service = new RuntimeService(
      configService as ConfigService,
      providerRegistry
    );
  });

  it("resolveRuntimeTarget delegates to the pure resolver with config", () => {
    const input = {
      userId: "u-1",
      workspaceId: "ws-1",
      workspaceRootPath: "/data/u-1/ws-1",
      userWorkspaceRootPath: "/data/u-1",
    };
    const result = service.resolveRuntimeTarget(input);
    expect(result.runtimeType).toBe("local");
    expect(result.ownerId).toBe("ws-1");
    expect(configService.getDefaultRuntimeType).toHaveBeenCalled();
  });

  it("shutdownRuntimeInstance dispatches to the resolved provider by type", () => {
    service.shutdownRuntimeInstance("sandbox", "ws-1");
    expect(resolveSpy).toHaveBeenCalledWith("sandbox");
    expect(shutdownRuntimeInstance).toHaveBeenCalledWith("ws-1");
  });

  it("shutdownRuntimeInstance resolves local to the registry no-op provider", () => {
    shutdownRuntimeInstance.mockClear();

    service.shutdownRuntimeInstance("local", "ws-1");
    expect(resolveSpy).toHaveBeenCalledWith("local");
    expect(shutdownRuntimeInstance).not.toHaveBeenCalled();
  });
});
