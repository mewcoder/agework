import { describe, it, expect, vi, beforeEach } from "vitest";
import { RuntimeService } from "./runtime.service";
import { RuntimeProviderRegistry } from "./providers/provider-registry";
import { ConfigService } from "../config/config.service";

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

  it("resolveRuntimeResource delegates to the pure resolver with config", () => {
    const input = {
      userId: "u-1",
      workspaceId: "ws-1",
      workspaceRootPath: "/data/u-1/ws-1",
      userWorkspaceRootPath: "/data/u-1",
    };
    const result = service.resolveRuntimeResource(input);
    expect(result.runtimeType).toBe("local");
    expect(result.resourceKey).toBe("ws-1");
    expect(configService.getDefaultRuntimeType).toHaveBeenCalled();
  });

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
