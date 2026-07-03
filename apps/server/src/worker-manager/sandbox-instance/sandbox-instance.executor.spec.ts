import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type {
  RunConfig,
  SandboxRuntimePlacement,
} from "@agework/shared/protocol";
import { SandboxInstanceExecutor } from "./sandbox-instance.executor";

function makeRuntimeService() {
  let nextId = 0;
  return {
    startSandbox: vi.fn().mockImplementation(async () => ({
      engineType: "docker",
      runtimeInstanceId: `docker-resource-${++nextId}`,
      workspaceMountPath: "/workspace",
    })),
    resumeSandbox: vi.fn(),
    stopSandbox: vi.fn().mockResolvedValue(undefined),
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
    runtimeLogDir: "/workspace-logs",
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

function makeService(runtimeService = makeRuntimeService()) {
  const config = {
    getSandboxEngine: vi.fn().mockReturnValue("docker"),
    getRuntimeLogDir: vi.fn().mockReturnValue("/tmp/agework-logs/runtime"),
    getIdleTimeoutSeconds: vi.fn().mockReturnValue(5),
    getLaunchTimeoutSeconds: vi.fn().mockReturnValue(60),
  };
  const commandDispatcher = {
    cleanupByOwnerId: vi.fn(),
  };
  const registry = {
    insertStarting: vi.fn().mockResolvedValue({ ok: true }),
    upsertRunning: vi.fn().mockResolvedValue({
      resource: { id: "rr-1", runtimeType: "sandbox" },
      workspaceRuntimeInstance: { id: "wr-1" },
    }),
    markStoppedByOwner: vi.fn().mockResolvedValue(undefined),
    markErrorByOwner: vi.fn().mockResolvedValue(undefined),
    isRuntimeInstanceBoundToWorkspace: vi.fn().mockResolvedValue(false),
  };
  const executor = new SandboxInstanceExecutor(
    config as never,
    runtimeService as never,
    registry as never,
    commandDispatcher as never
  );
  return { executor, runtimeService, config, registry, commandDispatcher };
}

function makeStartInput(placement = makePlacement(), runId = "run-1") {
  return {
    runConfig: makeRunConfig({ runId, workspaceId: placement.workspaceId }),
    runtimeTarget: {
      ...placement,
      ownerId:
        placement.sandbox?.isolationScope === "user"
          ? placement.userId
          : placement.workspaceId,
    },
  };
}

async function flushPromises() {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

describe("SandboxInstanceExecutor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("acquire creates the resource via RuntimeService and resolves ready", async () => {
    const { executor, runtimeService, registry } = makeService();

    const result = await executor.acquireInstanceForRun(makeStartInput());

    expect(runtimeService.startSandbox).toHaveBeenCalledWith(
      "docker",
      expect.objectContaining({
        placement: expect.objectContaining({ ownerId: "ws-1" }),
        env: expect.objectContaining({ AGEWORK_WORKER_OWNER_ID: "ws-1" }),
      })
    );
    expect(result).toEqual({
      outcome: "ready",
      runtimeInstanceId: "docker-resource-1",
    });
    expect(registry.upsertRunning).toHaveBeenCalledWith(
      {
        runtimeType: "sandbox",
        isolationScope: "workspace",
        workspaceId: "ws-1",
        ownerId: "ws-1",
      },
      "docker-resource-1",
      "http"
    );
  });

  it("acquire attaches a second run of the same owner to the pending container", async () => {
    const runtimeService = makeRuntimeService();
    let resolveGetOrCreate: (runtime: unknown) => void;
    runtimeService.startSandbox.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveGetOrCreate = resolve;
        })
    );
    const { executor } = makeService(runtimeService);

    const first = executor.acquireInstanceForRun(makeStartInput());
    const second = executor.acquireInstanceForRun(
      makeStartInput(makePlacement(), "run-2")
    );
    await flushPromises();
    resolveGetOrCreate!({
      engineType: "docker",
      runtimeInstanceId: "docker-resource-1",
      workspaceMountPath: "/workspace",
    });

    await expect(first).resolves.toMatchObject({
      outcome: "ready",
      runtimeInstanceId: "docker-resource-1",
    });
    await expect(second).resolves.toMatchObject({
      outcome: "ready",
      runtimeInstanceId: "docker-resource-1",
    });
    // 一个 owner 只创建一个容器,第二个 run 复用 pending。
    expect(runtimeService.startSandbox).toHaveBeenCalledTimes(1);
  });

  it("acquire resolves cancelledBeforeReady when released before the container is ready", async () => {
    const runtimeService = makeRuntimeService();
    let resolveGetOrCreate: (runtime: unknown) => void;
    runtimeService.startSandbox.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveGetOrCreate = resolve;
        })
    );
    const { executor } = makeService(runtimeService);

    const acquire = executor.acquireInstanceForRun(makeStartInput());
    executor.releaseInstanceForRun("run-1");
    await flushPromises();
    resolveGetOrCreate!({
      engineType: "docker",
      runtimeInstanceId: "docker-resource-1",
      workspaceMountPath: "/workspace",
    });

    await expect(acquire).resolves.toEqual({ outcome: "cancelledBeforeReady" });
  });

  it("acquire resolves error when the container fails to create", async () => {
    const runtimeService = makeRuntimeService();
    runtimeService.startSandbox.mockRejectedValue(new Error("boom"));
    const { executor, commandDispatcher } = makeService(runtimeService);

    const result = await executor.acquireInstanceForRun(makeStartInput());

    expect(result.outcome).toBe("error");
    expect(commandDispatcher.cleanupByOwnerId).toHaveBeenCalledWith("ws-1");
  });

  it("release after ready lets the idle watchdog stop the container", async () => {
    const { executor, runtimeService, registry } = makeService();

    await executor.acquireInstanceForRun(makeStartInput());
    executor.releaseInstanceForRun("run-1");
    await vi.advanceTimersByTimeAsync(5_500);

    expect(runtimeService.stopSandbox).toHaveBeenCalledWith(
      "docker",
      "docker-resource-1"
    );
    expect(registry.markStoppedByOwner).toHaveBeenCalledWith(
      "sandbox",
      "workspace",
      "ws-1"
    );
  });

  it("shutdownRuntimeInstanceByOwnerId stops the resource and cleans worker-manager owner state", async () => {
    const { executor, runtimeService, registry, commandDispatcher } =
      makeService();

    await executor.acquireInstanceForRun(makeStartInput());
    executor.shutdownRuntimeInstanceByOwnerId("ws-1");
    await flushPromises();

    expect(runtimeService.stopSandbox).toHaveBeenCalledWith(
      "docker",
      "docker-resource-1"
    );
    expect(commandDispatcher.cleanupByOwnerId).toHaveBeenCalledWith("ws-1");
    expect(registry.markStoppedByOwner).toHaveBeenCalledWith(
      "sandbox",
      "workspace",
      "ws-1"
    );
  });

  it("writes a starting row before creating the container, then flips it to running", async () => {
    const { executor, registry } = makeService();

    await executor.acquireInstanceForRun(makeStartInput());

    expect(registry.insertStarting).toHaveBeenCalledWith(
      {
        runtimeType: "sandbox",
        isolationScope: "workspace",
        workspaceId: "ws-1",
        ownerId: "ws-1",
      },
      expect.any(String),
      "http"
    );
    expect(registry.upsertRunning).toHaveBeenCalledWith(
      {
        runtimeType: "sandbox",
        isolationScope: "workspace",
        workspaceId: "ws-1",
        ownerId: "ws-1",
      },
      "docker-resource-1",
      "http"
    );
  });

  it("attaches to an existing running row on insertStarting conflict instead of creating a new container", async () => {
    const runtimeService = makeRuntimeService();
    const { executor, registry } = makeService(runtimeService);
    registry.insertStarting.mockResolvedValueOnce({
      ok: false,
      existing: {
        runtimeInstanceId: "docker-resource-existing",
        status: "running",
      },
    });

    const result = await executor.acquireInstanceForRun(makeStartInput());

    expect(result).toEqual({
      outcome: "ready",
      runtimeInstanceId: "docker-resource-existing",
    });
    expect(runtimeService.startSandbox).not.toHaveBeenCalled();
  });

  it("resolves error on insertStarting conflict against a starting row (concurrent launch in progress)", async () => {
    const runtimeService = makeRuntimeService();
    const { executor, registry } = makeService(runtimeService);
    registry.insertStarting.mockResolvedValueOnce({
      ok: false,
      existing: { runtimeInstanceId: "placeholder-x", status: "starting" },
    });

    const result = await executor.acquireInstanceForRun(makeStartInput());

    expect(result.outcome).toBe("error");
    expect(runtimeService.startSandbox).not.toHaveBeenCalled();
  });

  it("marks the row as error when the container never becomes ready within the launch timeout", async () => {
    const runtimeService = makeRuntimeService();
    runtimeService.startSandbox.mockImplementation(
      () =>
        new Promise(() => {
          /* never resolves */
        })
    );
    const { executor, registry, config } = makeService(runtimeService);
    config.getLaunchTimeoutSeconds.mockReturnValue(1);

    const acquire = executor.acquireInstanceForRun(makeStartInput());
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await acquire;

    expect(result.outcome).toBe("error");
    expect(registry.markErrorByOwner).toHaveBeenCalledWith(
      "sandbox",
      "workspace",
      "ws-1",
      expect.stringContaining("timed out")
    );
  });
});
