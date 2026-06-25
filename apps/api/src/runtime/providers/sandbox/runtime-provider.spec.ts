import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SandboxRuntimeProvider } from "./runtime-provider";
import { SandboxRuntimeResourceService } from "./runtime-resource.service";
import { SandboxWorkerSessionService } from "./worker-session.service";
import type { SandboxEngine, SandboxRuntime } from "./engine";
import type {
  IsolationScope,
  RuntimePlacement,
  ResolvedRuntimeResource,
} from "@agework/shared/protocol";
import { resolvedRuntimeResourceFromPlacement } from "../../resources/resolved-runtime-resource";

// ── Mock engine ──────────────────────────────────────────────────────

function makeMockEngine(type: "docker" | "opensandbox"): SandboxEngine {
  let nextId = 0;
  return {
    type,
    getOrCreate: vi.fn().mockImplementation(async () => ({
      engineType: type,
      runtimeResourceId: `${type}-resource-${++nextId}`,
      workspaceMountPath: "/workspace",
    })),
    startWorker: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    resume: vi.fn().mockImplementation(async (runtimeResourceId: string) => ({
      engineType: type,
      runtimeResourceId,
      workspaceMountPath: "/workspace",
    })),
    recoverOrphan: vi.fn().mockResolvedValue(undefined),
  };
}

// ── Shared mock deps ─────────────────────────────────────────────────

function makeProvider(engineOverride?: SandboxEngine) {
  const engine = engineOverride ?? makeMockEngine("docker");
  const eventProcessor = {
    forceErrorStatus: vi.fn().mockResolvedValue(undefined),
    forceCancelledStatus: vi.fn().mockResolvedValue(undefined),
    isTerminalOrFinalizing: vi.fn().mockReturnValue(false),
  };
  const configStore = { register: vi.fn(), unregister: vi.fn() };
  const access = {
    issueWorkspaceKey: vi.fn().mockReturnValue("ws-key"),
    issueRuntimeResourceKey: vi.fn().mockReturnValue("resource-key"),
    registerRun: vi.fn(),
    revokeWorkspace: vi.fn(),
    revokeAccess: vi.fn(),
  };
  const controlQueue = {
    pushForWorkspace: vi.fn(),
    cleanupWorkspace: vi.fn(),
    cleanup: vi.fn(),
  };
  const config = {
    getIdleTimeoutSeconds: vi.fn().mockReturnValue(1800),
    getSandboxEngine: vi.fn().mockReturnValue("docker"),
    getRuntimeLogDir: vi.fn().mockReturnValue("/tmp/agework-logs/runtime"),
  };
  const workspaceRuntimeService = {
    markStopped: vi.fn().mockResolvedValue(undefined),
    markStoppedByResourceKey: vi.fn().mockResolvedValue(undefined),
    upsertRunning: vi.fn().mockResolvedValue({
      resource: { id: "rr-1", runtimeType: "sandbox" },
      workspaceRuntime: { id: "wr-1" },
    }),
    findActiveByWorkspace: vi.fn().mockResolvedValue(null),
    isRuntimeResourceBoundToWorkspace: vi.fn().mockResolvedValue(false),
  };

  const runtimeResources = new SandboxRuntimeResourceService(
    config as never,
    workspaceRuntimeService as never,
    access as never,
    [engine]
  );
  const workerSessions = new SandboxWorkerSessionService(
    configStore as never,
    access as never,
    controlQueue as never
  );
  const provider = new SandboxRuntimeProvider(
    runtimeResources,
    workerSessions
  );
  provider.setRunEventReceiver(eventProcessor as never);

  return {
    provider, engine, access, controlQueue, configStore, eventProcessor,
    config, workspaceRuntimeService,
  };
}

const baseRun = {
  runId: "run-1",
  conversationId: "conversation-1",
  workspaceId: "ws-1",
  runtimePath: "/workspace",
  env: {},
  input: {},
  agentProviderConfig: { agentType: "claude" as const, source: "custom" as const },
};

function makePlacement(overrides?: Partial<RuntimePlacement>): RuntimePlacement {
  return {
    runtimeType: "sandbox",
    userId: "user-1",
    workspaceId: "ws-1",
    hostPath: "/tmp/workspace",
    runtimePath: "/workspace",
    sandbox: {
      isolationScope: "workspace" as IsolationScope,
      mountTarget: "/workspace",
      sandboxEngineType: "docker",
    },
    ...overrides,
  };
}

function makeRuntimeResource(
  overrides: Partial<ResolvedRuntimeResource> = {}
): ResolvedRuntimeResource {
  const placement = overrides.placement ?? makePlacement();
  return {
    runtimeType: "sandbox",
    resourceKey: "ws-1",
    workspaceId: "ws-1",
    placement,
    ...overrides,
  };
}

function startProvider(
  provider: SandboxRuntimeProvider,
  runConfig = baseRun,
  placement = makePlacement()
) {
  return provider.startWorkerExecution({
    runtimeResource: resolvedRuntimeResourceFromPlacement(placement),
    runConfig: runConfig as never,
  });
}

// ── Provider contract tests ─────────────────────────────────────────

describe("SandboxRuntimeProvider — provider contracts", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("startWorkerExecution fails fast when the runtime resource is not sandbox", () => {
    const { provider, engine } = makeProvider();

    expect(() =>
      provider.startWorkerExecution({
        runtimeResource: makeRuntimeResource({ runtimeType: "local" }),
        runConfig: baseRun as never,
      })
    ).toThrow(
      "SandboxRuntimeProvider cannot start worker for runtime type: local"
    );
    expect(engine.getOrCreate).not.toHaveBeenCalled();
  });
});

// ── Workspace-scoped tests ───────────────────────────────────────────

describe("SandboxRuntimeProvider — workspace scope", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("starts a sandbox for the first run and returns handle with runtimeType=sandbox", async () => {
    const { provider } = makeProvider();
    const handle = startProvider(provider);
    await vi.runOnlyPendingTimersAsync();

    expect(handle.runtimeType).toBe("sandbox");
    expect(handle.runId).toBe("run-1");
    expect(handle.conversationId).toBe("conversation-1");
  });

  it("delegates to engine.getOrCreate for the first run", async () => {
    const { provider, engine } = makeProvider();
    startProvider(provider);
    await vi.runOnlyPendingTimersAsync();

    expect(engine.getOrCreate).toHaveBeenCalledTimes(1);
    expect(engine.getOrCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        placement: expect.objectContaining({
          isolationScope: "workspace",
          resourceKey: "ws-1",
        }),
        env: expect.objectContaining({
          AGEWORK_INTERNAL_RUNTIME_TYPE: "sandbox",
          AGEWORK_INTERNAL_SANDBOX_ENGINE: "docker",
          AGEWORK_INTERNAL_ISOLATION_SCOPE: "workspace",
          AGEWORK_INTERNAL_RUNTIME_RESOURCE_KEY: "ws-1",
          AGEWORK_INTERNAL_RUNTIME_RESOURCE_NAME: "agework-worker-ws-1",
        }),
      })
    );
  });

  it("delegates to engine.startWorker after getOrCreate", async () => {
    const { provider, engine } = makeProvider();
    startProvider(provider);
    await vi.runOnlyPendingTimersAsync();

    expect(engine.startWorker).toHaveBeenCalledTimes(1);
  });

  it("passes a workspace binding check to the sandbox engine", async () => {
    const { provider, engine, workspaceRuntimeService } = makeProvider();
    startProvider(provider);
    await vi.runOnlyPendingTimersAsync();

    const input = (engine.getOrCreate as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    await input.isExpectedRuntimeResource("container-abc");

    expect(
      workspaceRuntimeService.isRuntimeResourceBoundToWorkspace
    ).toHaveBeenCalledWith("sandbox", "ws-1", "container-abc");
  });

  it("registers RunConfig and pushes user_message control", async () => {
    const { provider, configStore, controlQueue } = makeProvider();
    startProvider(provider);
    await vi.runOnlyPendingTimersAsync();

    expect(configStore.register).toHaveBeenCalledWith("run-1", expect.anything());
    expect(controlQueue.pushForWorkspace).toHaveBeenCalledWith(
      "ws-1",
      expect.objectContaining({
        runId: "run-1",
        payload: expect.objectContaining({
          type: "user_message",
          runId: "run-1",
        }),
      })
    );
  });

  it("reuses the existing sandbox for a second run (no second getOrCreate)", async () => {
    const { provider, engine, controlQueue } = makeProvider();
    startProvider(provider);
    await vi.runOnlyPendingTimersAsync();

    startProvider(provider, {
      ...baseRun, runId: "run-2", conversationId: "conversation-2",
    });
    await vi.runOnlyPendingTimersAsync();

    expect(engine.getOrCreate).toHaveBeenCalledTimes(1);
    expect(controlQueue.pushForWorkspace).toHaveBeenCalledTimes(2);
  });

  it("reports error when engine.getOrCreate fails", async () => {
    const engine = makeMockEngine("docker");
    (engine.getOrCreate as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("engine unavailable")
    );
    const { provider, eventProcessor } = makeProvider(engine);

    startProvider(provider);
    await vi.runOnlyPendingTimersAsync();

    expect(eventProcessor.forceErrorStatus).toHaveBeenCalledWith(
      "run-1",
      expect.stringContaining("engine unavailable")
    );
  });

  it("cancel does not stop the sandbox", async () => {
    const { provider, engine } = makeProvider();
    const handle = startProvider(provider);
    await vi.runOnlyPendingTimersAsync();

    provider.cancel(handle);
    expect(engine.stop).not.toHaveBeenCalled();
  });

  it("cancel sends a cancel control via control queue", async () => {
    const { provider, controlQueue } = makeProvider();
    const handle = startProvider(provider);
    await vi.runOnlyPendingTimersAsync();

    provider.cancel(handle);
    expect(controlQueue.pushForWorkspace).toHaveBeenCalledWith(
      "ws-1",
      expect.objectContaining({
        payload: expect.objectContaining({
          type: "cancel",
          runId: "run-1",
          conversationId: "conversation-1",
        }),
      })
    );
  });

  it("cancel during sandbox startup publishes cancelled status immediately", async () => {
    const engine = makeMockEngine("docker");
    let resolveGetOrCreate: (value: SandboxRuntime) => void;
    (engine.getOrCreate as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise<SandboxRuntime>((resolve) => { resolveGetOrCreate = resolve; })
    );
    const { provider, eventProcessor } = makeProvider(engine);

    const handle = startProvider(provider);
    provider.cancel(handle);

    resolveGetOrCreate!({
      engineType: "docker",
      runtimeResourceId: "resource-1",
      workspaceMountPath: "/workspace",
    });
    await vi.runOnlyPendingTimersAsync();
    await Promise.resolve();

    expect(eventProcessor.forceCancelledStatus).toHaveBeenCalledWith("run-1");
  });

  it("cleanup revokes per-run access without stopping sandbox", async () => {
    const { provider, access, engine } = makeProvider();
    startProvider(provider);
    await vi.runOnlyPendingTimersAsync();

    provider.cleanup("run-1");
    expect(access.revokeAccess).toHaveBeenCalledWith("run-1");
    expect(engine.stop).not.toHaveBeenCalled();
  });

  it("shutdownRuntimeResource stops sandbox via engine and revokes workspace key", async () => {
    const { provider, engine, access } = makeProvider();
    startProvider(provider);
    await vi.runOnlyPendingTimersAsync();

    provider.shutdownRuntimeResource("ws-1");
    expect(engine.stop).toHaveBeenCalled();
    expect(access.revokeWorkspace).toHaveBeenCalledWith("ws-1");
  });

  it("heartbeat feeds the heartbeat watchdog", async () => {
    const { provider } = makeProvider();
    startProvider(provider);
    await vi.runOnlyPendingTimersAsync();

    for (let i = 0; i < 20; i++) {
      vi.advanceTimersByTime(5_000);
      provider.heartbeat("run-1");
    }
  });

  it("marks run as error after 60s without heartbeat, without stopping the sandbox or revoking access", async () => {
    const { provider, engine, eventProcessor, access } = makeProvider();
    startProvider(provider);
    await vi.runOnlyPendingTimersAsync();

    await vi.advanceTimersByTimeAsync(65_000);

    expect(eventProcessor.forceErrorStatus).toHaveBeenCalledWith(
      "run-1",
      "worker heartbeat timeout"
    );
    expect(access.revokeWorkspace).not.toHaveBeenCalled();
    expect(engine.stop).not.toHaveBeenCalled();
  });

  it("resumes the previous container on the next run after a heartbeat timeout", async () => {
    const { provider, engine } = makeProvider();
    startProvider(provider);
    await vi.runOnlyPendingTimersAsync();

    await vi.advanceTimersByTimeAsync(65_000);

    startProvider(provider, {
      ...baseRun, runId: "run-2", conversationId: "conv-2",
    });
    await vi.runOnlyPendingTimersAsync();

    expect(engine.resume).toHaveBeenCalledWith("docker-resource-1", expect.anything());
    expect(engine.getOrCreate).toHaveBeenCalledTimes(1);
  });

  it("getHandle returns handle with runtimeType=sandbox", async () => {
    const { provider } = makeProvider();
    startProvider(provider);
    await vi.runOnlyPendingTimersAsync();

    const handle = provider.getHandle("run-1");
    expect(handle).toBeDefined();
    expect(handle!.runtimeType).toBe("sandbox");
  });

  it("upserts WorkspaceRuntime after sandbox creation", async () => {
    const { provider, workspaceRuntimeService, access } = makeProvider();
    startProvider(provider);
    await vi.runOnlyPendingTimersAsync();

    expect(workspaceRuntimeService.upsertRunning).toHaveBeenCalledWith(
      expect.objectContaining({ runtimeType: "sandbox" }),
      expect.any(String)
    );
    expect(access.issueRuntimeResourceKey).toHaveBeenCalledWith(
      "rr-1",
      "ws-1",
      "sandbox"
    );
  });
});

// ── User-scoped tests ────────────────────────────────────────────────

describe("SandboxRuntimeProvider — user scope", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const userPlacement = makePlacement({
    userId: "user-1",
    hostPath: "/tmp/workspace",
    runtimePath: "/workspaces",
    sandbox: {
      isolationScope: "user",
      mountTarget: "/workspaces",
      sandboxEngineType: "docker",
    },
  });

  it("same user, different workspaces → reuses the same sandbox", async () => {
    const { provider, engine, controlQueue } = makeProvider();

    startProvider(
      provider,
      { ...baseRun, runId: "run-1", workspaceId: "ws-1" } as never,
      userPlacement as never
    );
    await vi.runOnlyPendingTimersAsync();

    startProvider(
      provider,
      {
        ...baseRun,
        runId: "run-2",
        conversationId: "conv-2",
        workspaceId: "ws-2",
      } as never,
      { ...userPlacement, workspaceId: "ws-2" } as never
    );
    await vi.runOnlyPendingTimersAsync();

    expect(engine.getOrCreate).toHaveBeenCalledTimes(1);
    expect(controlQueue.pushForWorkspace).toHaveBeenCalledTimes(2);
  });

  it("different users → no reuse, separate sandboxes", async () => {
    const { provider, engine } = makeProvider();

    startProvider(
      provider,
      { ...baseRun, runId: "run-1", workspaceId: "ws-1" } as never,
      userPlacement as never
    );
    await vi.runOnlyPendingTimersAsync();

    startProvider(
      provider,
      {
        ...baseRun,
        runId: "run-2",
        conversationId: "conv-2",
        workspaceId: "ws-2",
      } as never,
      { ...userPlacement, userId: "user-2", workspaceId: "ws-2" } as never
    );
    await vi.runOnlyPendingTimersAsync();

    expect(engine.getOrCreate).toHaveBeenCalledTimes(2);
  });

  it("heartbeatRuntimeResource feeds the heartbeat watchdog for user scope", async () => {
    const { provider } = makeProvider();

    startProvider(
      provider,
      { ...baseRun, runId: "run-1", workspaceId: "ws-1" } as never,
      userPlacement as never
    );
    await vi.runOnlyPendingTimersAsync();

    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(25_000);
      provider.heartbeatRuntimeResource("user-1");
    }
  });

  it("shutdownRuntimeResource for user scope tears down the shared user sandbox", async () => {
    const { provider, engine, workspaceRuntimeService } = makeProvider();

    startProvider(
      provider,
      { ...baseRun, runId: "run-1", workspaceId: "ws-1" } as never,
      userPlacement as never
    );
    await vi.runOnlyPendingTimersAsync();
    provider.shutdownRuntimeResource("user-1");

    expect(engine.stop).toHaveBeenCalled();
    expect(workspaceRuntimeService.markStoppedByResourceKey).toHaveBeenCalledWith(
      "sandbox",
      "user",
      "user-1"
    );
  });
});

// ── Idle stop tests ──────────────────────────────────────────────────

describe("SandboxRuntimeProvider — idle stop", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("starts idle timer when all runs finish (cleanup)", async () => {
    const { provider, engine, config } = makeProvider();
    config.getIdleTimeoutSeconds.mockReturnValue(10);

    startProvider(provider);
    await vi.runOnlyPendingTimersAsync();

    provider.cleanup("run-1");
    await vi.advanceTimersByTimeAsync(10_500);

    expect(engine.stop).toHaveBeenCalled();
  });

  it("cancels idle timer when a new run starts before timeout", async () => {
    const { provider, engine, config } = makeProvider();
    config.getIdleTimeoutSeconds.mockReturnValue(10);

    startProvider(provider);
    await vi.runOnlyPendingTimersAsync();

    provider.cleanup("run-1");
    vi.advanceTimersByTime(5_000);

    startProvider(provider, {
      ...baseRun, runId: "run-2", conversationId: "conv-2",
    });
    await vi.runOnlyPendingTimersAsync();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(engine.stop).not.toHaveBeenCalled();
  });

  it("after idle timeout, marks resource stopped and resets runtimeResourceId without revoking access", async () => {
    const { provider, config, workspaceRuntimeService, access } = makeProvider();
    config.getIdleTimeoutSeconds.mockReturnValue(5);

    startProvider(provider);
    await vi.runOnlyPendingTimersAsync();

    provider.cleanup("run-1");
    await vi.advanceTimersByTimeAsync(5_500);

    expect(workspaceRuntimeService.markStoppedByResourceKey).toHaveBeenCalledWith(
      "sandbox",
      "workspace",
      "ws-1"
    );
    expect(access.revokeWorkspace).not.toHaveBeenCalled();
  });

  it("next run after idle stop resumes the previous container", async () => {
    const { provider, engine, config } = makeProvider();
    config.getIdleTimeoutSeconds.mockReturnValue(5);

    startProvider(provider);
    await vi.runOnlyPendingTimersAsync();

    provider.cleanup("run-1");
    await vi.advanceTimersByTimeAsync(5_500);

    const getOrCreateCallsBefore = (engine.getOrCreate as ReturnType<typeof vi.fn>).mock.calls.length;

    startProvider(provider, {
      ...baseRun, runId: "run-2", conversationId: "conv-2",
    });
    await vi.runOnlyPendingTimersAsync();

    expect(engine.resume).toHaveBeenCalledWith("docker-resource-1", expect.anything());
    const getOrCreateCallsAfter = (engine.getOrCreate as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(getOrCreateCallsAfter).toBe(getOrCreateCallsBefore);
  });

  it("falls back to getOrCreate when resume fails after idle stop", async () => {
    const { provider, engine, config } = makeProvider();
    config.getIdleTimeoutSeconds.mockReturnValue(5);

    startProvider(provider);
    await vi.runOnlyPendingTimersAsync();

    provider.cleanup("run-1");
    await vi.advanceTimersByTimeAsync(5_500);

    (engine.resume as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("resume failed"));

    startProvider(provider, {
      ...baseRun, runId: "run-2", conversationId: "conv-2",
    });
    await vi.runOnlyPendingTimersAsync();

    expect(engine.resume).toHaveBeenCalledWith("docker-resource-1", expect.anything());
    expect(engine.getOrCreate).toHaveBeenCalledTimes(2);
  });

  it("does not start idle timer if activeRuns still has entries", async () => {
    const { provider, engine, config } = makeProvider();
    config.getIdleTimeoutSeconds.mockReturnValue(5);

    startProvider(provider);
    await vi.runOnlyPendingTimersAsync();

    startProvider(provider, {
      ...baseRun, runId: "run-2", conversationId: "conv-2",
    });
    await vi.runOnlyPendingTimersAsync();

    provider.cleanup("run-1");
    await vi.advanceTimersByTimeAsync(6_000);

    expect(engine.stop).not.toHaveBeenCalled();
  });
});

// ── recoverOrphan tests ──────────────────────────────────────────────

describe("SandboxRuntimeProvider.recoverOrphan", () => {
  it("delegates to engine.recoverOrphan", async () => {
    const { provider, engine } = makeProvider();
    await provider.recoverOrphan("resource-abc");
    expect(engine.recoverOrphan).toHaveBeenCalledWith("resource-abc");
  });
});
