import { describe, expect, it, vi } from "vitest";
import type { RunConfig, SandboxRuntimePlacement } from "@agework/shared/protocol";
import { SandboxWorkerSessionService } from "./worker-session.service";
import type {
  SandboxScopeState,
  SandboxWorkerExecutionContext,
} from "./runtime-instance.service";

function makeContext(
  overrides: Partial<SandboxWorkerExecutionContext> = {}
): SandboxWorkerExecutionContext {
  const runConfig = {
    runId: "run-1",
    conversationId: "conversation-1",
    workspaceId: "ws-1",
    input: { prompt: "hello" },
  } as RunConfig;
  const placement = {
    runtimeType: "sandbox",
    userId: "user-1",
    workspaceId: "ws-1",
    hostPath: "/host/ws-1",
    runtimePath: "/workspace",
    sandbox: {
      isolationScope: "workspace",
      mountTarget: "/workspace",
      sandboxEngineType: "docker",
    },
  } as SandboxRuntimePlacement;
  return {
    runConfig,
    runtimeTarget: { ...placement, resourceKey: "ws-1" },
    placement,
    runId: "run-1",
    workspaceId: "ws-1",
    resourceKey: "ws-1",
    isolationScope: "workspace",
    engineType: "docker",
    engine: {} as never,
    ...overrides,
  };
}

function makeScopeState(): SandboxScopeState {
  return {
    runtimeInstanceId: "",
    accessKey: "workspace-key",
    activeRuns: new Map(),
    isolationScope: "workspace",
    engineType: "docker",
  };
}

function makeService() {
  const configStore = { register: vi.fn(), unregister: vi.fn() };
  const access = {
    registerRun: vi.fn(),
    revokeAccess: vi.fn(),
  };
  const controlQueue = {
    pushForWorkspace: vi.fn(),
    cleanup: vi.fn(),
    cleanupWorkspace: vi.fn(),
  };
  const service = new SandboxWorkerSessionService(
    configStore as never,
    access as never,
    controlQueue as never
  );
  return { service, configStore, access, controlQueue };
}

describe("SandboxWorkerSessionService", () => {
  it("registers run config without touching control queue", () => {
    const { service, configStore, controlQueue } = makeService();
    const context = makeContext();

    service.registerRunConfig(context);

    expect(configStore.register).toHaveBeenCalledWith(
      "run-1",
      context.runConfig
    );
    expect(controlQueue.pushForWorkspace).not.toHaveBeenCalled();
  });

  it("registers run session and enqueues the first user_message control", () => {
    const { service, access, controlQueue } = makeService();
    const context = makeContext();
    const scopeState = makeScopeState();

    service.registerRunSession(context, scopeState);

    expect(access.registerRun).toHaveBeenCalledWith("run-1", "workspace-key");
    expect(scopeState.activeRuns.get("run-1")).toBe("conversation-1");
    expect(controlQueue.pushForWorkspace).toHaveBeenCalledWith(
      "ws-1",
      expect.objectContaining({
        runId: "run-1",
        seq: 1,
        payload: expect.objectContaining({
          type: "user_message",
          runId: "run-1",
          input: { prompt: "hello" },
        }),
      })
    );
  });

  it("increments control sequence per resource key", () => {
    const { service, controlQueue } = makeService();
    const context = makeContext();
    const scopeState = makeScopeState();

    service.registerRunSession(context, scopeState);
    service.sendControl("ws-1", "run-1", {
      type: "cancel",
      commandId: "command-2",
      runId: "run-1",
      conversationId: "conversation-1",
    });

    expect(controlQueue.pushForWorkspace).toHaveBeenNthCalledWith(
      2,
      "ws-1",
      expect.objectContaining({
        runId: "run-1",
        seq: 2,
        payload: expect.objectContaining({ type: "cancel" }),
      })
    );
  });

  it("tracks cancel-before-ready runs as consumable state", () => {
    const { service } = makeService();

    service.markCancelledBeforeReady("run-1");

    expect(service.consumeCancelledStartingRun("run-1")).toBe(true);
    expect(service.consumeCancelledStartingRun("run-1")).toBe(false);
  });

  it("cleans run and workspace session state", () => {
    const { service, configStore, access, controlQueue } = makeService();

    service.cleanupRun("run-1");
    service.cleanupWorkspace("ws-1");

    expect(configStore.unregister).toHaveBeenCalledWith("run-1");
    expect(access.revokeAccess).toHaveBeenCalledWith("run-1");
    expect(controlQueue.cleanup).toHaveBeenCalledWith("run-1");
    expect(controlQueue.cleanupWorkspace).toHaveBeenCalledWith("ws-1");
  });
});
