import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SandboxRunExecutor } from "./sandbox.executor";
import { SandboxRuntimeInstanceService } from "../../runtime/sandbox/sandbox-instance.service";
import { WorkerCommandDispatcher } from "../../worker-host/command-dispatcher.service";
import type {
  SandboxEngine,
  SandboxRuntime,
} from "../../runtime/sandbox/sandbox-engine";
import type {
  IsolationScope,
  RuntimePlacement,
  RuntimeTarget,
} from "@agework/shared/protocol";

// ── Mock engine ──────────────────────────────────────────────────────

function makeMockEngine(type: "docker" | "opensandbox"): SandboxEngine {
  let nextId = 0;
  return {
    type,
    getOrCreate: vi.fn().mockImplementation(async () => ({
      engineType: type,
      runtimeInstanceId: `${type}-resource-${++nextId}`,
      workspaceMountPath: "/workspace",
    })),
    startWorker: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    resume: vi.fn().mockImplementation(async (runtimeInstanceId: string) => ({
      engineType: type,
      runtimeInstanceId,
      workspaceMountPath: "/workspace",
    })),
    recoverOrphan: vi.fn().mockResolvedValue(undefined),
  };
}

// ── Shared mock deps ─────────────────────────────────────────────────

function makeProvider(engineOverride?: SandboxEngine) {
  const engine = engineOverride ?? makeMockEngine("docker");
  const eventProcessor = {
    sendEvent: vi.fn().mockResolvedValue(undefined),
    notifyWorkerError: vi.fn().mockResolvedValue(undefined),
    notifyCancelledBeforeReady: vi.fn().mockResolvedValue(undefined),
    recordCommandSent: vi.fn().mockResolvedValue(undefined),
  };
  const configStore = { register: vi.fn(), unregister: vi.fn() };
  const access = {
    issueOwnerKey: vi.fn().mockReturnValue("owner-key"),
    registerRun: vi.fn(),
    revokeOwner: vi.fn(),
    revokeAccess: vi.fn(),
  };
  const commandQueue = {
    pushByOwnerId: vi.fn(),
    cleanupByOwnerId: vi.fn(),
    cleanup: vi.fn(),
  };
  const config = {
    getIdleTimeoutSeconds: vi.fn().mockReturnValue(1800),
    getSandboxEngine: vi.fn().mockReturnValue("docker"),
    getRuntimeLogDir: vi.fn().mockReturnValue("/tmp/agework-logs/runtime"),
  };
  const workspaceRuntimeService = {
    markStoppedByOwner: vi.fn().mockResolvedValue(undefined),
    upsertRunning: vi.fn().mockResolvedValue({
      resource: { id: "rr-1", runtimeType: "sandbox" },
      workspaceRuntimeInstance: { id: "wr-1" },
    }),
    findActiveByWorkspace: vi.fn().mockResolvedValue(null),
    isRuntimeInstanceBoundToWorkspace: vi.fn().mockResolvedValue(false),
  };

  const runtimeInstances = new SandboxRuntimeInstanceService(
    config as never,
    workspaceRuntimeService as never,
    [engine]
  );
  const workerSessions = new WorkerCommandDispatcher(
    configStore as never,
    access as never,
    commandQueue as never
  );
  const provider = new SandboxRunExecutor(
    runtimeInstances,
    workerSessions,
    access as never
  );
  provider.setRunEventReceiver(eventProcessor as never);

  return {
    provider,
    engine,
    access,
    commandQueue,
    configStore,
    eventProcessor,
    config,
    workspaceRuntimeService,
  };
}

const baseRun = {
  runId: "run-1",
  conversationId: "conversation-1",
  workspaceId: "ws-1",
  runtimePath: "/workspace",
  env: {},
  input: {},
  agentProviderConfig: {
    agentType: "claude" as const,
    source: "custom" as const,
  },
};

function makePlacement(
  overrides?: Partial<RuntimePlacement>
): RuntimePlacement {
  return {
    runtimeType: "sandbox",
    userId: "user-1",
    workspaceId: "ws-1",
    hostPath: "/tmp/workspace",
    runtimePath: "/workspace",
    sandbox: {
      isolationScope: "workspace",
      mountTarget: "/workspace",
      sandboxEngineType: "docker",
    },
    ...overrides,
  };
}

function makeRuntimeTarget(
  overrides: Partial<RuntimeTarget> = {}
): RuntimeTarget {
  return {
    ...makePlacement(),
    ownerId: "ws-1",
    ...overrides,
  } as RuntimeTarget;
}

function startProvider(
  provider: SandboxRunExecutor,
  runConfig = baseRun,
  placement = makePlacement()
) {
  return provider.start({
    runtimeTarget: {
      ...placement,
      ownerId:
        (placement as { sandbox: { isolationScope: string } }).sandbox
          .isolationScope === "user"
          ? placement.userId
          : placement.workspaceId,
    },
    runConfig: runConfig as never,
  });
}

// ── Provider contract tests ─────────────────────────────────────────

describe("SandboxRunExecutor — executor contract", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("start fails fast when the runtime resource is not sandbox", () => {
    const { provider, engine } = makeProvider();

    expect(() =>
      provider.start({
        runtimeTarget: makeRuntimeTarget({ runtimeType: "local" }),
        runConfig: baseRun as never,
      })
    ).toThrow(
      "SandboxRunExecutor cannot start worker for runtime type: local"
    );
    expect(engine.getOrCreate).not.toHaveBeenCalled();
  });
});

// ── Workspace-scoped tests ───────────────────────────────────────────

describe("SandboxRunExecutor — workspace scope", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts a sandbox for the first run and returns handle with runtimeType=sandbox", async () => {
    const { provider } = makeProvider();
    const handle = startProvider(provider);
    await vi.runOnlyPendingTimersAsync();

    expect(handle.runtimeType).toBe("sandbox");
    expect(handle.runId).toBe("run-1");
    expect(handle.conversationId).toBe("conversation-1");
  });

  it("updates handle runtimeInstanceId when reusing a ready runtime resource", async () => {
    const { provider, engine } = makeProvider();
    const firstHandle = startProvider(provider);
    await vi.runOnlyPendingTimersAsync();

    const secondHandle = startProvider(provider, {
      ...baseRun,
      runId: "run-2",
      conversationId: "conversation-2",
    });

    expect(firstHandle.runtimeInstanceId).toBe("docker-resource-1");
    expect(secondHandle.runtimeInstanceId).toBe("docker-resource-1");
    expect(engine.getOrCreate).toHaveBeenCalledTimes(1);
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
          ownerId: "ws-1",
        }),
        env: expect.objectContaining({
          AGEWORK_WORKER_RUNTIME_TYPE: "sandbox",
          AGEWORK_WORKER_SANDBOX_ENGINE: "docker",
          AGEWORK_WORKER_ISOLATION_SCOPE: "workspace",
          AGEWORK_WORKER_OWNER_ID: "ws-1",
          AGEWORK_WORKER_RUNTIME_RESOURCE_NAME: "agework-worker-ws-1",
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
    await input.isExpectedRuntimeInstance("container-abc");

    expect(
      workspaceRuntimeService.isRuntimeInstanceBoundToWorkspace
    ).toHaveBeenCalledWith("sandbox", "ws-1", "container-abc");
  });

  it("registers RunConfig and pushes user_message control", async () => {
    const { provider, configStore, commandQueue } = makeProvider();
    startProvider(provider);
    await vi.runOnlyPendingTimersAsync();

    expect(configStore.register).toHaveBeenCalledWith(
      "run-1",
      expect.anything()
    );
    expect(commandQueue.pushByOwnerId).toHaveBeenCalledWith(
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
    const { provider, engine, commandQueue } = makeProvider();
    startProvider(provider);
    await vi.runOnlyPendingTimersAsync();

    startProvider(provider, {
      ...baseRun,
      runId: "run-2",
      conversationId: "conversation-2",
    });
    await vi.runOnlyPendingTimersAsync();

    expect(engine.getOrCreate).toHaveBeenCalledTimes(1);
    expect(commandQueue.pushByOwnerId).toHaveBeenCalledTimes(2);
  });

  it("reports error and cleans worker session when engine.getOrCreate fails", async () => {
    const engine = makeMockEngine("docker");
    (engine.getOrCreate as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("engine unavailable")
    );
    const { provider, eventProcessor, commandQueue, access } =
      makeProvider(engine);

    startProvider(provider);
    await vi.runOnlyPendingTimersAsync();

    expect(eventProcessor.notifyWorkerError).toHaveBeenCalledWith(
      "run-1",
      expect.stringContaining("engine unavailable")
    );
    expect(commandQueue.cleanupByOwnerId).toHaveBeenCalledWith("ws-1");
    expect(access.revokeOwner).toHaveBeenCalledWith("ws-1");
  });

  it("cancel does not stop the sandbox", async () => {
    const { provider, engine } = makeProvider();
    const handle = startProvider(provider);
    await vi.runOnlyPendingTimersAsync();

    provider.cancel(handle);
    expect(engine.stop).not.toHaveBeenCalled();
  });

  it("cancel sends a cancel control via control queue", async () => {
    const { provider, commandQueue } = makeProvider();
    const handle = startProvider(provider);
    await vi.runOnlyPendingTimersAsync();

    provider.cancel(handle);
    expect(commandQueue.pushByOwnerId).toHaveBeenCalledWith(
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
      () =>
        new Promise<SandboxRuntime>((resolve) => {
          resolveGetOrCreate = resolve;
        })
    );
    const { provider, eventProcessor } = makeProvider(engine);

    const handle = startProvider(provider);
    provider.cancel(handle);

    resolveGetOrCreate!({
      engineType: "docker",
      runtimeInstanceId: "resource-1",
      workspaceMountPath: "/workspace",
    });
    await vi.runOnlyPendingTimersAsync();
    await Promise.resolve();

    expect(eventProcessor.notifyCancelledBeforeReady).toHaveBeenCalledWith("run-1");
  });

  it("cleanup revokes per-run access without stopping sandbox", async () => {
    const { provider, access, engine } = makeProvider();
    startProvider(provider);
    await vi.runOnlyPendingTimersAsync();

    provider.cleanup("run-1");
    expect(access.revokeAccess).toHaveBeenCalledWith("run-1");
    expect(engine.stop).not.toHaveBeenCalled();
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
    const { provider, workspaceRuntimeService } = makeProvider();
    startProvider(provider);
    await vi.runOnlyPendingTimersAsync();

    expect(workspaceRuntimeService.upsertRunning).toHaveBeenCalledWith(
      expect.objectContaining({ runtimeType: "sandbox" }),
      expect.any(String),
      expect.any(String)
    );
  });
});

// ── User-scoped tests ────────────────────────────────────────────────

describe("SandboxRunExecutor — user scope", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

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
    const { provider, engine, commandQueue } = makeProvider();

    startProvider(
      provider,
      { ...baseRun, runId: "run-1", workspaceId: "ws-1" },
      userPlacement
    );
    await vi.runOnlyPendingTimersAsync();

    startProvider(
      provider,
      {
        ...baseRun,
        runId: "run-2",
        conversationId: "conv-2",
        workspaceId: "ws-2",
      },
      { ...userPlacement, workspaceId: "ws-2" }
    );
    await vi.runOnlyPendingTimersAsync();

    expect(engine.getOrCreate).toHaveBeenCalledTimes(1);
    expect(commandQueue.pushByOwnerId).toHaveBeenCalledTimes(2);
  });

  it("different users → no reuse, separate sandboxes", async () => {
    const { provider, engine } = makeProvider();

    startProvider(
      provider,
      { ...baseRun, runId: "run-1", workspaceId: "ws-1" },
      userPlacement
    );
    await vi.runOnlyPendingTimersAsync();

    startProvider(
      provider,
      {
        ...baseRun,
        runId: "run-2",
        conversationId: "conv-2",
        workspaceId: "ws-2",
      },
      { ...userPlacement, userId: "user-2", workspaceId: "ws-2" }
    );
    await vi.runOnlyPendingTimersAsync();

    expect(engine.getOrCreate).toHaveBeenCalledTimes(2);
  });

});

// ── Idle stop tests ──────────────────────────────────────────────────

describe("SandboxRunExecutor — idle stop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

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
      ...baseRun,
      runId: "run-2",
      conversationId: "conv-2",
    });
    await vi.runOnlyPendingTimersAsync();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(engine.stop).not.toHaveBeenCalled();
  });

  it("after idle timeout, marks resource stopped and resets runtimeInstanceId without revoking access", async () => {
    const { provider, config, workspaceRuntimeService, access } =
      makeProvider();
    config.getIdleTimeoutSeconds.mockReturnValue(5);

    startProvider(provider);
    await vi.runOnlyPendingTimersAsync();

    provider.cleanup("run-1");
    await vi.advanceTimersByTimeAsync(5_500);

    expect(workspaceRuntimeService.markStoppedByOwner).toHaveBeenCalledWith(
      "sandbox",
      "workspace",
      "ws-1"
    );
    expect(access.revokeOwner).not.toHaveBeenCalled();
  });

  it("next run after idle stop resumes the previous container", async () => {
    const { provider, engine, config } = makeProvider();
    config.getIdleTimeoutSeconds.mockReturnValue(5);

    startProvider(provider);
    await vi.runOnlyPendingTimersAsync();

    provider.cleanup("run-1");
    await vi.advanceTimersByTimeAsync(5_500);

    const getOrCreateCallsBefore = (
      engine.getOrCreate as ReturnType<typeof vi.fn>
    ).mock.calls.length;

    startProvider(provider, {
      ...baseRun,
      runId: "run-2",
      conversationId: "conv-2",
    });
    await vi.runOnlyPendingTimersAsync();

    expect(engine.resume).toHaveBeenCalledWith(
      "docker-resource-1",
      expect.anything()
    );
    const getOrCreateCallsAfter = (
      engine.getOrCreate as ReturnType<typeof vi.fn>
    ).mock.calls.length;
    expect(getOrCreateCallsAfter).toBe(getOrCreateCallsBefore);
  });

  it("falls back to getOrCreate when resume fails after idle stop", async () => {
    const { provider, engine, config } = makeProvider();
    config.getIdleTimeoutSeconds.mockReturnValue(5);

    startProvider(provider);
    await vi.runOnlyPendingTimersAsync();

    provider.cleanup("run-1");
    await vi.advanceTimersByTimeAsync(5_500);

    (engine.resume as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("resume failed")
    );

    startProvider(provider, {
      ...baseRun,
      runId: "run-2",
      conversationId: "conv-2",
    });
    await vi.runOnlyPendingTimersAsync();

    expect(engine.resume).toHaveBeenCalledWith(
      "docker-resource-1",
      expect.anything()
    );
    expect(engine.getOrCreate).toHaveBeenCalledTimes(2);
  });

  it("does not start idle timer while owner still has active run references", async () => {
    const { provider, engine, config } = makeProvider();
    config.getIdleTimeoutSeconds.mockReturnValue(5);

    startProvider(provider);
    await vi.runOnlyPendingTimersAsync();

    startProvider(provider, {
      ...baseRun,
      runId: "run-2",
      conversationId: "conv-2",
    });
    await vi.runOnlyPendingTimersAsync();

    provider.cleanup("run-1");
    await vi.advanceTimersByTimeAsync(6_000);

    expect(engine.stop).not.toHaveBeenCalled();
  });
});

// ── interrupted execution cleanup tests ──────────────────────────────

describe("SandboxRunExecutor.cleanupInterruptedExecution", () => {
  it("delegates runtime resource cleanup to the sandbox engine", async () => {
    const { provider, engine } = makeProvider();
    await provider.cleanupInterruptedExecution("resource-abc");
    expect(engine.recoverOrphan).toHaveBeenCalledWith("resource-abc");
  });
});
