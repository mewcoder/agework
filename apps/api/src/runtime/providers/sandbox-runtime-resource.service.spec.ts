import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { RunConfig, SandboxRuntimePlacement } from "@agework/shared/protocol";
import type { SandboxEngine, SandboxRuntime } from "./sandbox-engine";
import { SandboxRuntimeResourceService } from "./sandbox-runtime-resource.service";

function makeEngine(): SandboxEngine {
  let nextId = 0;
  return {
    type: "docker",
    getOrCreate: vi.fn().mockImplementation(async () => ({
      engineType: "docker",
      runtimeResourceId: `docker-resource-${++nextId}`,
      workspaceMountPath: "/workspace",
    })),
    startWorker: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    resume: vi.fn().mockImplementation(async (runtimeResourceId: string) => ({
      engineType: "docker",
      runtimeResourceId,
      workspaceMountPath: "/workspace",
    })),
    recoverOrphan: vi.fn().mockResolvedValue(undefined),
  };
}

function makePlacement(
  overrides: Partial<SandboxRuntimePlacement> = {}
): SandboxRuntimePlacement {
  return {
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
    ...overrides,
  } as SandboxRuntimePlacement;
}

function makeRunConfig(overrides: Partial<RunConfig> = {}): RunConfig {
  return {
    runId: "run-1",
    conversationId: "conversation-1",
    workspaceId: "ws-1",
    runtimePath: "/workspace",
    env: {},
    input: {},
    agentProviderConfig: { agentType: "claude", source: "custom" },
    ...overrides,
  } as RunConfig;
}

function makeService(engine = makeEngine()) {
  const config = {
    getSandboxEngine: vi.fn().mockReturnValue("docker"),
    getRuntimeLogDir: vi.fn().mockReturnValue("/tmp/agework-logs/runtime"),
    getIdleTimeoutSeconds: vi.fn().mockReturnValue(5),
  };
  const workspaceRuntimeService = {
    upsertRunning: vi.fn().mockResolvedValue({
      resource: { id: "rr-1", runtimeType: "sandbox" },
      workspaceRuntime: { id: "wr-1" },
    }),
    markStoppedByResourceKey: vi.fn().mockResolvedValue(undefined),
    isRuntimeResourceBoundToWorkspace: vi.fn().mockResolvedValue(false),
  };
  const access = {
    issueWorkspaceKey: vi.fn().mockReturnValue("workspace-key"),
    issueRuntimeResourceKey: vi.fn(),
    revokeWorkspace: vi.fn(),
  };
  const service = new SandboxRuntimeResourceService(
    config as never,
    workspaceRuntimeService as never,
    access as never,
    [engine]
  );
  return { service, engine, config, workspaceRuntimeService, access };
}

function makeStartInput(placement = makePlacement()) {
  return {
    runConfig: makeRunConfig({ workspaceId: placement.workspaceId }),
    runtimeResource: {
      runtimeType: "sandbox",
      resourceKey:
        placement.sandbox?.isolationScope === "user"
          ? placement.userId
          : placement.workspaceId,
      workspaceId: placement.workspaceId,
      placement,
    },
  };
}

function makeCallbacks() {
  return {
    consumeCancelledStartingRun: vi.fn().mockReturnValue(false),
    forceCancelled: vi.fn(),
    publishWorkerError: vi.fn(),
    cleanupWorkspace: vi.fn(),
  };
}

async function flushPromises() {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

describe("SandboxRuntimeResourceService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves context and creates initial scope state", () => {
    const { service, access } = makeService();
    const context = service.resolveWorkerExecutionContext(makeStartInput());

    const scopeState = service.ensureScopeState(context);

    expect(context).toMatchObject({
      runId: "run-1",
      workspaceId: "ws-1",
      resourceKey: "ws-1",
      isolationScope: "workspace",
      engineType: "docker",
    });
    expect(scopeState).toMatchObject({
      runtimeResourceId: "",
      accessKey: "workspace-key",
      isolationScope: "workspace",
      engineType: "docker",
    });
    expect(access.issueWorkspaceKey).toHaveBeenCalledWith("ws-1");
  });

  it("starts a runtime resource and records WorkspaceRuntime when ready", async () => {
    const { service, engine, workspaceRuntimeService, access } = makeService();
    const context = service.resolveWorkerExecutionContext(makeStartInput());
    const scopeState = service.ensureScopeState(context);
    scopeState.activeRuns.set("run-1", "conversation-1");
    const handle = service.createRunHandle(context);
    const onReady = vi.fn();

    service.attachOrStartRuntimeResource(
      { context, scopeState, handle, onRuntimeResourceIdReady: onReady },
      makeCallbacks()
    );
    await flushPromises();

    expect(engine.getOrCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        placement: expect.objectContaining({
          resourceKey: "ws-1",
          workspaceId: "ws-1",
        }),
        env: expect.objectContaining({
          AGEWORK_INTERNAL_RUNTIME_TYPE: "sandbox",
          AGEWORK_INTERNAL_RUNTIME_RESOURCE_KEY: "ws-1",
        }),
      })
    );
    expect(engine.startWorker).toHaveBeenCalled();
    expect(handle.runtimeResourceId).toBe("docker-resource-1");
    expect(onReady).toHaveBeenCalledWith("docker-resource-1");
    expect(workspaceRuntimeService.upsertRunning).toHaveBeenCalledWith(
      context.placement,
      "docker-resource-1"
    );
    expect(access.issueRuntimeResourceKey).toHaveBeenCalledWith(
      "rr-1",
      "ws-1",
      "sandbox"
    );
  });

  it("publishes cancelled status for runs cancelled before runtime is ready", async () => {
    const engine = makeEngine();
    let resolveGetOrCreate: (runtime: SandboxRuntime) => void;
    vi.mocked(engine.getOrCreate).mockImplementation(
      () =>
        new Promise<SandboxRuntime>((resolve) => {
          resolveGetOrCreate = resolve;
        })
    );
    const { service } = makeService(engine);
    const context = service.resolveWorkerExecutionContext(makeStartInput());
    const scopeState = service.ensureScopeState(context);
    scopeState.activeRuns.set("run-1", "conversation-1");
    const callbacks = makeCallbacks();
    callbacks.consumeCancelledStartingRun.mockReturnValueOnce(true);

    service.attachOrStartRuntimeResource(
      { context, scopeState, handle: service.createRunHandle(context) },
      callbacks
    );
    resolveGetOrCreate!({
      engineType: "docker",
      runtimeResourceId: "docker-resource-1",
      workspaceMountPath: "/workspace",
    });
    await flushPromises();

    expect(scopeState.activeRuns.has("run-1")).toBe(false);
    expect(callbacks.forceCancelled).toHaveBeenCalledWith("run-1");
  });

  it("stops and marks a runtime resource after idle cleanup timeout", async () => {
    const { service, engine, workspaceRuntimeService } = makeService();
    const context = service.resolveWorkerExecutionContext(makeStartInput());
    const scopeState = service.ensureScopeState(context);
    scopeState.activeRuns.set("run-1", "conversation-1");
    service.attachOrStartRuntimeResource(
      { context, scopeState, handle: service.createRunHandle(context) },
      makeCallbacks()
    );
    await flushPromises();

    service.cleanupRun("run-1");
    await vi.advanceTimersByTimeAsync(5_500);

    expect(engine.stop).toHaveBeenCalledWith("docker-resource-1");
    expect(workspaceRuntimeService.markStoppedByResourceKey).toHaveBeenCalledWith(
      "sandbox",
      "workspace",
      "ws-1"
    );
  });

  it("shutdownRuntimeResource stops active resource and cleans workspace state", async () => {
    const { service, engine, access, workspaceRuntimeService } = makeService();
    const context = service.resolveWorkerExecutionContext(makeStartInput());
    const scopeState = service.ensureScopeState(context);
    scopeState.activeRuns.set("run-1", "conversation-1");
    service.attachOrStartRuntimeResource(
      { context, scopeState, handle: service.createRunHandle(context) },
      makeCallbacks()
    );
    await flushPromises();
    const callbacks = { cleanupWorkspace: vi.fn() };

    service.shutdownRuntimeResource("ws-1", callbacks);

    expect(engine.stop).toHaveBeenCalledWith("docker-resource-1");
    expect(access.revokeWorkspace).toHaveBeenCalledWith("ws-1");
    expect(callbacks.cleanupWorkspace).toHaveBeenCalledWith("ws-1");
    expect(workspaceRuntimeService.markStoppedByResourceKey).toHaveBeenCalledWith(
      "sandbox",
      "workspace",
      "ws-1"
    );
  });

  it("delegates orphan recovery to engines", async () => {
    const { service, engine } = makeService();

    await service.recoverOrphan("resource-abc");

    expect(engine.recoverOrphan).toHaveBeenCalledWith("resource-abc");
  });
});
