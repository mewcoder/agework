import { describe, it, expect, vi, beforeEach } from "vitest";
import { RuntimeService } from "./runtime.service";
import { RuntimePlacementPolicy } from "./core/runtime-resources/runtime-placement.policy";
import { RuntimeProviderRegistry } from "./providers/runtime-provider-registry";
import type {
  IsolationScope,
  RuntimePlacement,
} from "@agework/shared/protocol";

function makeProvider() {
  return {
    type: "local",
    startWorkerExecution: vi.fn(),
    heartbeatRuntimeResource: vi.fn(),
    shutdownRuntimeResource: vi.fn(),
  };
}

const placement = (
  runtimeType: string,
  overrides: Partial<RuntimePlacement> = {}
): RuntimePlacement => {
  const sandbox =
    runtimeType === "sandbox"
      ? {
          isolationScope: "workspace" as IsolationScope,
          mountTarget: "/ws",
          sandboxEngineType: "docker" as const,
        }
      : undefined;
  return {
    runtimeType: runtimeType as RuntimePlacement["runtimeType"],
    userId: "user-1",
    workspaceId: "ws-1",
    hostPath: "/ws",
    runtimePath: "/ws",
    ...(sandbox ? { sandbox } : {}),
    ...overrides,
  } as RuntimePlacement;
};

describe("RuntimeService", () => {
  let placementPolicy: Partial<RuntimePlacementPolicy>;
  let providerRegistry: Partial<RuntimeProviderRegistry>;
  let provider: ReturnType<typeof makeProvider>;
  let service: RuntimeService;

  beforeEach(() => {
    provider = makeProvider();
    placementPolicy = {
      resolveForRun: vi.fn().mockReturnValue(placement("local")),
    };
    providerRegistry = {
      resolve: vi.fn().mockReturnValue(provider),
      all: vi.fn().mockReturnValue([provider]),
    };
    service = new RuntimeService(
      placementPolicy as RuntimePlacementPolicy,
      providerRegistry as RuntimeProviderRegistry
    );
  });

  it("resolvePlacement delegates to RuntimePlacementPolicy", () => {
    const input = {
      userId: "u",
      workspaceId: "w",
      workspaceRootPath: "/a",
      userWorkspaceRootPath: "/a",
    };
    service.resolvePlacement(input);
    expect(placementPolicy.resolveForRun).toHaveBeenCalledWith(input);
  });

  it("provision returns a runtime resource handle without starting a worker", async () => {
    const p = placement("sandbox", {
      workspaceId: "ws-1",
    });

    const result = await service.provision(p);

    expect(result).toEqual({
      runtimeType: "sandbox",
      resourceKey: "ws-1",
      workspaceId: "ws-1",
      placement: p,
    });
    expect(providerRegistry.resolve).toHaveBeenCalledWith("sandbox");
    expect(provider.startWorkerExecution).not.toHaveBeenCalled();
  });

  it("provision delegates to provider-side provision when available", async () => {
    const p = placement("local");
    const expected = {
      runtimeType: "local",
      resourceKey: "ws-1",
      workspaceId: "ws-1",
      placement: p,
    };
    const provision = vi.fn().mockReturnValue(expected);
    Object.assign(provider, {
      provision,
    });

    await expect(service.provision(p)).resolves.toBe(expected);

    expect(providerRegistry.resolve).toHaveBeenCalledWith("local");
    expect(provision).toHaveBeenCalledWith(p);
    expect(provider.startWorkerExecution).not.toHaveBeenCalled();
  });

  it("provision uses userId as resourceKey for user isolation", async () => {
    const p = placement("sandbox", {
      sandbox: {
        isolationScope: "user",
        mountTarget: "/ws",
        sandboxEngineType: "docker",
      },
      userId: "user-1",
      workspaceId: "ws-2",
    });

    await expect(service.provision(p)).resolves.toMatchObject({
      resourceKey: "user-1",
      workspaceId: "ws-2",
    });
  });

  it("provision fails fast for an unknown isolation scope", async () => {
    const p = placement("sandbox", {
      sandbox: {
        isolationScope: "unknown" as IsolationScope,
        mountTarget: "/ws",
        sandboxEngineType: "docker",
      },
    });

    await expect(service.provision(p)).rejects.toThrow(
      "Unknown runtime isolation scope: unknown"
    );
  });

  it("provision fails fast when required placement fields are missing", async () => {
    await expect(
      service.provision(placement(""))
    ).rejects.toThrow("Runtime placement runtimeType is required");

    await expect(
      service.provision(
        placement("sandbox", {
          sandbox: {
            isolationScope: "user",
            mountTarget: "/ws",
            sandboxEngineType: "docker",
          },
          userId: "",
        })
      )
    ).rejects.toThrow("Runtime placement userId is required");

    await expect(
      service.provision(
        placement("sandbox", {
          workspaceId: "",
        })
      )
    ).rejects.toThrow("Runtime placement workspaceId is required");
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
