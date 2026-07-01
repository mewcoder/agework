import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type {
  RunConfig,
  SandboxRuntimePlacement,
} from "@agework/shared/protocol";
import { SandboxInstanceExecutor } from "./sandbox-instance.executor";

function makeRuntimeService() {
  let nextId = 0;
  return {
    getOrCreateSandbox: vi.fn().mockImplementation(async () => ({
      engineType: "docker",
      runtimeInstanceId: `docker-resource-${++nextId}`,
      workspaceMountPath: "/workspace",
    })),
    resumeSandbox: vi.fn(),
    startSandboxWorker: vi.fn().mockResolvedValue(undefined),
    stopSandbox: vi.fn().mockResolvedValue(undefined),
    recoverOrphanSandbox: vi.fn().mockResolvedValue(undefined),
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

function makeService(runtimeService = makeRuntimeService()) {
  const config = {
    getSandboxEngine: vi.fn().mockReturnValue("docker"),
    getRuntimeLogDir: vi.fn().mockReturnValue("/tmp/agework-logs/runtime"),
    getIdleTimeoutSeconds: vi.fn().mockReturnValue(5),
  };
  const workerHost = {
    cleanupByOwnerId: vi.fn(),
    upsertRunningRuntime: vi.fn().mockResolvedValue({
      resource: { id: "rr-1", runtimeType: "sandbox" },
      workspaceRuntimeInstance: { id: "wr-1" },
    }),
    markRuntimeStoppedByOwner: vi.fn().mockResolvedValue(undefined),
    isRuntimeInstanceBoundToWorkspace: vi.fn().mockResolvedValue(false),
  };
  const executor = new SandboxInstanceExecutor(
    config as never,
    runtimeService as never,
    workerHost as never
  );
  return { executor, runtimeService, config, workerHost };
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
    const { executor, runtimeService, workerHost } = makeService();

    const result = await executor.acquireInstanceForRun(makeStartInput());

    expect(runtimeService.getOrCreateSandbox).toHaveBeenCalledWith(
      "docker",
      expect.objectContaining({
        placement: expect.objectContaining({ ownerId: "ws-1" }),
        env: expect.objectContaining({ AGEWORK_WORKER_OWNER_ID: "ws-1" }),
      })
    );
    expect(runtimeService.startSandboxWorker).toHaveBeenCalled();
    expect(result).toEqual({
      outcome: "ready",
      runtimeInstanceId: "docker-resource-1",
    });
    expect(workerHost.upsertRunningRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: "ws-1" }),
      "ws-1",
      "docker-resource-1"
    );
  });

  it("acquire attaches a second run of the same owner to the pending container", async () => {
    const runtimeService = makeRuntimeService();
    let resolveGetOrCreate: (runtime: unknown) => void;
    runtimeService.getOrCreateSandbox.mockImplementation(
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
    expect(runtimeService.getOrCreateSandbox).toHaveBeenCalledTimes(1);
  });

  it("acquire resolves cancelledBeforeReady when released before the container is ready", async () => {
    const runtimeService = makeRuntimeService();
    let resolveGetOrCreate: (runtime: unknown) => void;
    runtimeService.getOrCreateSandbox.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveGetOrCreate = resolve;
        })
    );
    const { executor } = makeService(runtimeService);

    const acquire = executor.acquireInstanceForRun(makeStartInput());
    executor.releaseInstanceForRun("run-1");
    resolveGetOrCreate!({
      engineType: "docker",
      runtimeInstanceId: "docker-resource-1",
      workspaceMountPath: "/workspace",
    });

    await expect(acquire).resolves.toEqual({ outcome: "cancelledBeforeReady" });
  });

  it("acquire resolves error when the container fails to create", async () => {
    const runtimeService = makeRuntimeService();
    runtimeService.getOrCreateSandbox.mockRejectedValue(new Error("boom"));
    const { executor, workerHost } = makeService(runtimeService);

    const result = await executor.acquireInstanceForRun(makeStartInput());

    expect(result.outcome).toBe("error");
    expect(workerHost.cleanupByOwnerId).toHaveBeenCalledWith("ws-1");
  });

  it("release after ready lets the idle watchdog stop the container", async () => {
    const { executor, runtimeService, workerHost } = makeService();

    await executor.acquireInstanceForRun(makeStartInput());
    executor.releaseInstanceForRun("run-1");
    await vi.advanceTimersByTimeAsync(5_500);

    expect(runtimeService.stopSandbox).toHaveBeenCalledWith(
      "docker",
      "docker-resource-1"
    );
    expect(workerHost.markRuntimeStoppedByOwner).toHaveBeenCalledWith(
      "sandbox",
      "workspace",
      "ws-1"
    );
  });

  it("shutdownRuntimeInstanceByOwnerId stops the resource and cleans worker-host owner state", async () => {
    const { executor, runtimeService, workerHost } = makeService();

    await executor.acquireInstanceForRun(makeStartInput());
    executor.shutdownRuntimeInstanceByOwnerId("ws-1");
    await flushPromises();

    expect(runtimeService.stopSandbox).toHaveBeenCalledWith(
      "docker",
      "docker-resource-1"
    );
    expect(workerHost.cleanupByOwnerId).toHaveBeenCalledWith("ws-1");
    expect(workerHost.markRuntimeStoppedByOwner).toHaveBeenCalledWith(
      "sandbox",
      "workspace",
      "ws-1"
    );
  });

  it("delegates orphan recovery to RuntimeService.recoverOrphanSandbox", async () => {
    const { executor, runtimeService } = makeService();

    await executor.recoverOrphan("resource-abc");

    expect(runtimeService.recoverOrphanSandbox).toHaveBeenCalledWith(
      "resource-abc"
    );
  });
});
