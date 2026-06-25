import { describe, it, expect, vi, beforeEach } from "vitest";
import { RuntimeService } from "./runtime.service";
import { RuntimeProviderRegistry } from "./providers/provider-registry";
import { ConfigService } from "../config/config.service";

describe("RuntimeService", () => {
  let configService: Partial<ConfigService>;
  let providerRegistry: Partial<RuntimeProviderRegistry>;
  let provider: {
    type: string;
    heartbeatRuntimeInstance: ReturnType<typeof vi.fn>;
    shutdownRuntimeInstance: ReturnType<typeof vi.fn>;
  };
  let service: RuntimeService;

  beforeEach(() => {
    provider = {
      type: "local",
      heartbeatRuntimeInstance: vi.fn(),
      shutdownRuntimeInstance: vi.fn(),
    };
    configService = {
      getDefaultRuntimeType: vi.fn().mockReturnValue("local"),
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

  it("resolveRuntimeTarget delegates to the pure resolver with config", () => {
    const input = {
      userId: "u-1",
      workspaceId: "ws-1",
      workspaceRootPath: "/data/u-1/ws-1",
      userWorkspaceRootPath: "/data/u-1",
    };
    const result = service.resolveRuntimeTarget(input);
    expect(result.runtimeType).toBe("local");
    expect(result.resourceKey).toBe("ws-1");
    expect(configService.getDefaultRuntimeType).toHaveBeenCalled();
  });

  it("heartbeatRuntimeInstance broadcasts to all providers by resource key", () => {
    service.heartbeatRuntimeInstance("ws-1");
    expect(providerRegistry.all).toHaveBeenCalled();
    expect(provider.heartbeatRuntimeInstance).toHaveBeenCalledWith("ws-1");
  });

  it("shutdownRuntimeInstance dispatches to the resolved provider by type", () => {
    service.shutdownRuntimeInstance("sandbox", "ws-1");
    expect(providerRegistry.resolve).toHaveBeenCalledWith("sandbox");
    expect(provider.shutdownRuntimeInstance).toHaveBeenCalledWith("ws-1");
  });
});
