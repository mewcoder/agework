import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type {
  RunConfig,
  SandboxRuntimePlacement,
} from "@agework/shared/protocol";
import type { SandboxEngine, SandboxRuntime } from "./sandbox-engine";
import { SandboxRuntimeInstanceService } from "./sandbox-instance.service";

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
  const workerHost = {
    cleanupByOwnerId: vi.fn(),
  };
  const service = new SandboxRuntimeInstanceService(
    config as never,
    workspaceRuntimeService as never,
    workerHost as never,
    [engine]
  );
  return { service, engine, config, workspaceRuntimeService, workerHost };
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

describe("SandboxRuntimeInstanceService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("acquire creates the resource and resolves ready", async () => {
    const { service, engine, workspaceRuntimeService } = makeService();

    const result = await service.acquireInstanceForRun(makeStartInput());

    expect(engine.getOrCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        placement: expect.objectContaining({ ownerId: "ws-1" }),
        env: expect.objectContaining({
          AGEWORK_WORKER_OWNER_ID: "ws-1",
        }),
      })
    );
    expect(engine.startWorker).toHaveBeenCalled();
    expect(result).toEqual({
      outcome: "ready",
      runtimeInstanceId: "docker-resource-1",
    });
    expect(workspaceRuntimeService.upsertRunning).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: "ws-1" }),
      "ws-1",
      "docker-resource-1"
    );
  });

  it("acquire attaches a second run of the same owner to the pending container", async () => {
    const engine = makeEngine();
    let resolveGetOrCreate: (runtime: SandboxRuntime) => void;
    vi.mocked(engine.getOrCreate).mockImplementation(
      () =>
        new Promise<SandboxRuntime>((resolve) => {
          resolveGetOrCreate = resolve;
        })
    );
    const { service } = makeService(engine);

    const first = service.acquireInstanceForRun(makeStartInput());
    const second = service.acquireInstanceForRun(
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
    expect(engine.getOrCreate).toHaveBeenCalledTimes(1);
  });

  it("acquire resolves cancelledBeforeReady when released before the container is ready", async () => {
    const engine = makeEngine();
    let resolveGetOrCreate: (runtime: SandboxRuntime) => void;
    vi.mocked(engine.getOrCreate).mockImplementation(
      () =>
        new Promise<SandboxRuntime>((resolve) => {
          resolveGetOrCreate = resolve;
        })
    );
    const { service } = makeService(engine);

    const acquire = service.acquireInstanceForRun(makeStartInput());
    service.releaseInstanceForRun("run-1");
    resolveGetOrCreate!({
      engineType: "docker",
      runtimeInstanceId: "docker-resource-1",
      workspaceMountPath: "/workspace",
    });

    await expect(acquire).resolves.toEqual({
      outcome: "cancelledBeforeReady",
    });
  });

  it("acquire resolves error when the container fails to create", async () => {
    const engine = makeEngine();
    vi.mocked(engine.getOrCreate).mockRejectedValue(new Error("boom"));
    const { service, workerHost } = makeService(engine);

    const result = await service.acquireInstanceForRun(makeStartInput());

    expect(result.outcome).toBe("error");
    // owner 被拆除时清掉 worker-host owner 资源。
    expect(workerHost.cleanupByOwnerId).toHaveBeenCalledWith("ws-1");
  });

  it("release after ready lets the idle watchdog stop the container", async () => {
    const { service, engine, workspaceRuntimeService } = makeService();

    await service.acquireInstanceForRun(makeStartInput());
    service.releaseInstanceForRun("run-1");
    await vi.advanceTimersByTimeAsync(5_500);

    expect(engine.stop).toHaveBeenCalledWith("docker-resource-1");
    expect(workspaceRuntimeService.markStoppedByOwner).toHaveBeenCalledWith(
      "sandbox",
      "workspace",
      "ws-1"
    );
  });

  it("shutdownRuntimeInstanceByOwnerId stops the resource and cleans worker-host owner state", async () => {
    const { service, engine, workerHost, workspaceRuntimeService } =
      makeService();

    await service.acquireInstanceForRun(makeStartInput());
    service.shutdownRuntimeInstanceByOwnerId("ws-1");
    await flushPromises();

    expect(engine.stop).toHaveBeenCalledWith("docker-resource-1");
    expect(workerHost.cleanupByOwnerId).toHaveBeenCalledWith("ws-1");
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
