import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type {
  RunConfig,
  SandboxRuntimePlacement,
} from "@agework/shared/protocol";
import type { SandboxEngine, SandboxRuntime } from "./engine";
import { SandboxRuntimeInstanceService } from "./runtime-instance.service";

function makeEngine(): SandboxEngine {
  let nextId = 0;
  return {
    type: "docker",
    getOrCreate: vi.fn().mockImplementation(async () => ({
      engineType: "docker",
      runtimeInstanceId: `docker-resource-${++nextId}`,
      workspaceMountPath: "/workspace",
    })),
    startWorker: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    resume: vi.fn().mockImplementation(async (runtimeInstanceId: string) => ({
      engineType: "docker",
      runtimeInstanceId,
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
  };
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
      workspaceRuntimeInstance: { id: "wr-1" },
    }),
    markStoppedByOwner: vi.fn().mockResolvedValue(undefined),
    isRuntimeInstanceBoundToWorkspace: vi.fn().mockResolvedValue(false),
  };
  const access = {
    issueOwnerKey: vi.fn().mockReturnValue("owner-key"),
    issueRuntimeInstanceKey: vi.fn(),
    revokeOwner: vi.fn(),
  };
  const service = new SandboxRuntimeInstanceService(
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
    runtimeTarget: {
      ...placement,
      ownerId:
        placement.sandbox?.isolationScope === "user"
          ? placement.userId
          : placement.workspaceId,
    },
  };
}

function makeCallbacks() {
  return {
    consumeCancelledStartingRun: vi.fn().mockReturnValue(false),
    forceCancelled: vi.fn(),
    publishWorkerError: vi.fn(),
    cleanupByOwnerId: vi.fn(),
  };
}

async function flushPromises() {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

describe("SandboxRuntimeInstanceService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves context and creates initial owner state", () => {
    const { service, access } = makeService();
    const context = service.resolveWorkerExecutionContext(makeStartInput());

    const ownerState = service.ensureOwnerState(context);

    expect(context).toMatchObject({
      runId: "run-1",
      workspaceId: "ws-1",
      ownerId: "ws-1",
      isolationScope: "workspace",
      engineType: "docker",
    });
    expect(ownerState).toMatchObject({
      runtimeInstanceId: "",
      accessKey: "owner-key",
      isolationScope: "workspace",
      engineType: "docker",
    });
    expect(access.issueOwnerKey).toHaveBeenCalledWith("ws-1");
  });

  it("starts a runtime resource and records WorkspaceRuntime when ready", async () => {
    const { service, engine, workspaceRuntimeService, access } = makeService();
    const context = service.resolveWorkerExecutionContext(makeStartInput());
    const ownerState = service.ensureOwnerState(context);
    ownerState.activeRuns.set("run-1", "conversation-1");
    const handle = service.createRunHandle(context);
    const onReady = vi.fn();

    service.attachOrStartRuntimeInstance(
      { context, ownerState, handle, onRuntimeInstanceIdReady: onReady },
      makeCallbacks()
    );
    await flushPromises();

    expect(engine.getOrCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        placement: expect.objectContaining({
          ownerId: "ws-1",
          workspaceId: "ws-1",
        }),
        env: expect.objectContaining({
          AGEWORK_WORKER_RUNTIME_TYPE: "sandbox",
          AGEWORK_WORKER_OWNER_ID: "ws-1",
        }),
      })
    );
    expect(engine.startWorker).toHaveBeenCalled();
    expect(handle.runtimeInstanceId).toBe("docker-resource-1");
    expect(onReady).toHaveBeenCalledWith("docker-resource-1");
    expect(workspaceRuntimeService.upsertRunning).toHaveBeenCalledWith(
      context.placement,
      "ws-1",
      "docker-resource-1"
    );
    expect(access.issueRuntimeInstanceKey).toHaveBeenCalledWith(
      "docker-resource-1",
      "ws-1"
    );
    expect(
      vi.mocked(access.issueRuntimeInstanceKey).mock.invocationCallOrder[0]
    ).toBeLessThan(vi.mocked(engine.startWorker).mock.invocationCallOrder[0]);
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
    const ownerState = service.ensureOwnerState(context);
    ownerState.activeRuns.set("run-1", "conversation-1");
    const callbacks = makeCallbacks();
    callbacks.consumeCancelledStartingRun.mockReturnValueOnce(true);

    service.attachOrStartRuntimeInstance(
      { context, ownerState, handle: service.createRunHandle(context) },
      callbacks
    );
    resolveGetOrCreate!({
      engineType: "docker",
      runtimeInstanceId: "docker-resource-1",
      workspaceMountPath: "/workspace",
    });
    await flushPromises();

    expect(ownerState.activeRuns.has("run-1")).toBe(false);
    expect(callbacks.forceCancelled).toHaveBeenCalledWith("run-1");
  });

  it("stops and marks a runtime resource after idle cleanup timeout", async () => {
    const { service, engine, workspaceRuntimeService } = makeService();
    const context = service.resolveWorkerExecutionContext(makeStartInput());
    const ownerState = service.ensureOwnerState(context);
    ownerState.activeRuns.set("run-1", "conversation-1");
    service.attachOrStartRuntimeInstance(
      { context, ownerState, handle: service.createRunHandle(context) },
      makeCallbacks()
    );
    await flushPromises();

    service.cleanupRun("run-1");
    await vi.advanceTimersByTimeAsync(5_500);

    expect(engine.stop).toHaveBeenCalledWith("docker-resource-1");
    expect(workspaceRuntimeService.markStoppedByOwner).toHaveBeenCalledWith(
      "sandbox",
      "workspace",
      "ws-1"
    );
  });

  it("shutdownRuntimeInstance stops active resource and cleans workspace state", async () => {
    const { service, engine, access, workspaceRuntimeService } = makeService();
    const context = service.resolveWorkerExecutionContext(makeStartInput());
    const ownerState = service.ensureOwnerState(context);
    ownerState.activeRuns.set("run-1", "conversation-1");
    service.attachOrStartRuntimeInstance(
      { context, ownerState, handle: service.createRunHandle(context) },
      makeCallbacks()
    );
    await flushPromises();
    const callbacks = { cleanupByOwnerId: vi.fn() };

    service.shutdownRuntimeInstance("ws-1", callbacks);

    expect(engine.stop).toHaveBeenCalledWith("docker-resource-1");
    expect(access.revokeOwner).toHaveBeenCalledWith("ws-1");
    expect(callbacks.cleanupByOwnerId).toHaveBeenCalledWith("ws-1");
    expect(workspaceRuntimeService.markStoppedByOwner).toHaveBeenCalledWith(
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
