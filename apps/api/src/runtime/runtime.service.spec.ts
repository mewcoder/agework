import { describe, it, expect, vi, beforeEach } from "vitest";
import { RuntimeService } from "./runtime.service";
import { RuntimePlacementPolicy } from "./core/runtime-resources/runtime-placement.policy";
import { RuntimeProviderRegistry } from "./providers/runtime-provider-registry";
import type { RuntimeHandle, RuntimePlacement } from "@agework/shared/protocol";

function makeProvider() {
  return {
    type: "local",
    start: vi.fn(),
    sendControl: vi.fn(),
    cancel: vi.fn(),
    getHandle: vi.fn(),
    heartbeat: vi.fn(),
    cleanup: vi.fn(),
    recoverOrphan: vi.fn(),
  };
}

const placement = (runtimeType: string): RuntimePlacement =>
  ({ runtimeType, runtimePath: "/ws" }) as RuntimePlacement;

const handle = (runId: string, runtimeType: string): RuntimeHandle => ({
  runId,
  runtimeType,
  runtimeResourceId: "rr-1",
  conversationId: "c-1",
});

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
    providerRegistry = { resolve: vi.fn().mockReturnValue(provider) };
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

  it("startWorker resolves the provider by placement.runtimeType and calls start", () => {
    provider.start.mockReturnValue(handle("run-1", "local"));
    const cfg = { runId: "run-1" } as never;
    const p = placement("local");
    const onReady = vi.fn();

    const result = service.startWorker(cfg, p, onReady);

    expect(providerRegistry.resolve).toHaveBeenCalledWith("local");
    expect(provider.start).toHaveBeenCalledWith(cfg, p, onReady);
    expect(result.runId).toBe("run-1");
  });

  it("sendControl / cancel dispatch by handle.runtimeType", () => {
    const h = handle("run-1", "local");
    const control = { type: "cancel" } as never;

    service.sendControl(h, control);
    expect(provider.sendControl).toHaveBeenCalledWith(h, control);

    service.cancel(h);
    expect(provider.cancel).toHaveBeenCalledWith(h);
  });

  it("heartbeat / cleanup dispatch by the runId registered at startWorker", () => {
    provider.start.mockReturnValue(handle("run-1", "local"));
    service.startWorker({ runId: "run-1" } as never, placement("local"));

    service.heartbeat("run-1");
    expect(provider.heartbeat).toHaveBeenCalledWith("run-1");

    service.cleanup("run-1");
    expect(provider.cleanup).toHaveBeenCalledWith("run-1");
  });

  it("heartbeat / cleanup are no-ops for an unknown runId", () => {
    service.heartbeat("ghost");
    service.cleanup("ghost");
    expect(provider.heartbeat).not.toHaveBeenCalled();
    expect(provider.cleanup).not.toHaveBeenCalled();
  });

  it("cleanup unregisters the handle so later heartbeat no longer dispatches", () => {
    provider.start.mockReturnValue(handle("run-1", "local"));
    service.startWorker({ runId: "run-1" } as never, placement("local"));
    service.cleanup("run-1");

    service.heartbeat("run-1");
    expect(provider.heartbeat).not.toHaveBeenCalled();
  });
});
