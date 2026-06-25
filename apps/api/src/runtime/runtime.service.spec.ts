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

  it("resolveRuntimeResource delegates placement to RuntimePlacementPolicy", () => {
    const input = {
      userId: "u",
      workspaceId: "w",
      workspaceRootPath: "/a",
      userWorkspaceRootPath: "/a",
    };
    service.resolveRuntimeResource(input);
    expect(placementPolicy.resolveForRun).toHaveBeenCalledWith(input);
  });

  it("resolveRuntimeResource returns a runtime resource handle without starting a worker", () => {
    const p = placement("sandbox", { workspaceId: "ws-1" });
    (placementPolicy.resolveForRun as ReturnType<typeof vi.fn>).mockReturnValue(
      p
    );

    const result = service.resolveRuntimeResource({} as never);

    expect(result).toEqual({
      runtimeType: "sandbox",
      resourceKey: "ws-1",
      workspaceId: "ws-1",
      placement: p,
    });
    expect(provider.startWorkerExecution).not.toHaveBeenCalled();
  });

  it("resolveRuntimeResource uses userId as resourceKey for user isolation", () => {
    const p = placement("sandbox", {
      sandbox: {
        isolationScope: "user",
        mountTarget: "/ws",
        sandboxEngineType: "docker",
      },
      userId: "user-1",
      workspaceId: "ws-2",
    });
    (placementPolicy.resolveForRun as ReturnType<typeof vi.fn>).mockReturnValue(
      p
    );

    expect(service.resolveRuntimeResource({} as never)).toMatchObject({
      resourceKey: "user-1",
      workspaceId: "ws-2",
    });
  });

  it("resolveRuntimeResource fails fast for an unknown isolation scope", () => {
    const p = placement("sandbox", {
      sandbox: {
        isolationScope: "unknown" as IsolationScope,
        mountTarget: "/ws",
        sandboxEngineType: "docker",
      },
    });
    (placementPolicy.resolveForRun as ReturnType<typeof vi.fn>).mockReturnValue(
      p
    );

    expect(() => service.resolveRuntimeResource({} as never)).toThrow(
      "Unknown runtime isolation scope: unknown"
    );
  });

  it("resolveRuntimeResource fails fast when required placement fields are missing", () => {
    const resolveForRun = placementPolicy.resolveForRun as ReturnType<
      typeof vi.fn
    >;

    resolveForRun.mockReturnValue(placement(""));
    expect(() => service.resolveRuntimeResource({} as never)).toThrow(
      "Runtime placement runtimeType is required"
    );

    resolveForRun.mockReturnValue(
      placement("sandbox", {
        sandbox: {
          isolationScope: "user",
          mountTarget: "/ws",
          sandboxEngineType: "docker",
        },
        userId: "",
      })
    );
    expect(() => service.resolveRuntimeResource({} as never)).toThrow(
      "Runtime placement userId is required"
    );

    resolveForRun.mockReturnValue(placement("sandbox", { workspaceId: "" }));
    expect(() => service.resolveRuntimeResource({} as never)).toThrow(
      "Runtime placement workspaceId is required"
    );
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
