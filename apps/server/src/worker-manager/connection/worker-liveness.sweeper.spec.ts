import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WorkerLivenessSweeper } from "./worker-liveness.sweeper";
import { WORKER_LOST_EVENT, WorkerLostEvent } from "../worker-manager.events";

function makeDeps(
  overrides: {
    intervalSeconds?: number;
    timeoutSeconds?: number;
    stale?: string[];
  } = {}
) {
  const livenessStore = {
    listStale: vi.fn().mockReturnValue(overrides.stale ?? []),
    remove: vi.fn(),
  };
  const configService = {
    getHeartbeatCheckIntervalSeconds: vi
      .fn()
      .mockReturnValue(overrides.intervalSeconds ?? 20),
    getHeartbeatTimeoutSeconds: vi
      .fn()
      .mockReturnValue(overrides.timeoutSeconds ?? 75),
  };
  const registry = {
    findActiveByOwnerId: vi.fn().mockResolvedValue(null),
  };
  const provisioner = {
    stop: vi.fn().mockResolvedValue(undefined),
  };
  const events = {
    emit: vi.fn(),
  };
  const ownerRunStore = {
    registerRun: vi.fn(),
    unregisterRun: vi.fn(),
    runIdsForOwner: vi.fn().mockReturnValue([]),
  };
  return {
    livenessStore,
    configService,
    registry,
    provisioner,
    events,
    ownerRunStore,
  };
}

function makeSweeper(deps: ReturnType<typeof makeDeps>) {
  return new WorkerLivenessSweeper(
    deps.livenessStore as never,
    deps.configService as never,
    deps.registry as never,
    deps.provisioner as never,
    deps.events as never,
    deps.ownerRunStore as never
  );
}

function activeRow(overrides: Record<string, unknown> = {}) {
  return {
    startToken: "token",
    runtimeType: "docker",
    ownerId: "owner-1",
    instanceId: "container-1",
    isolationScope: "workspace",
    ...overrides,
  };
}

describe("WorkerLivenessSweeper — scheduling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not sweep before the check interval elapses", async () => {
    const deps = makeDeps({ intervalSeconds: 20 });
    const sweeper = makeSweeper(deps);

    sweeper.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(19_000);

    expect(deps.livenessStore.listStale).not.toHaveBeenCalled();
  });

  it("sweeps on each interval tick and fences every stale owner", async () => {
    const deps = makeDeps({
      intervalSeconds: 20,
      timeoutSeconds: 75,
      stale: ["owner-1", "owner-2"],
    });
    const sweeper = makeSweeper(deps);

    sweeper.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(20_000);

    expect(deps.livenessStore.listStale).toHaveBeenCalledWith(
      75_000,
      expect.any(Number)
    );
    expect(deps.registry.findActiveByOwnerId).toHaveBeenCalledWith("owner-1");
    expect(deps.registry.findActiveByOwnerId).toHaveBeenCalledWith("owner-2");
  });

  it("does not fence anyone when listStale returns no owners", async () => {
    const deps = makeDeps({ stale: [] });
    const sweeper = makeSweeper(deps);

    sweeper.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(20_000);

    expect(deps.registry.findActiveByOwnerId).not.toHaveBeenCalled();
  });

  it("keeps sweeping on subsequent ticks", async () => {
    const deps = makeDeps({ intervalSeconds: 20, stale: ["owner-1"] });
    const sweeper = makeSweeper(deps);

    sweeper.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(20_000);
    await vi.advanceTimersByTimeAsync(20_000);

    expect(deps.livenessStore.listStale).toHaveBeenCalledTimes(2);
  });

  it("swallows a fence rejection without breaking the interval", async () => {
    const deps = makeDeps({ intervalSeconds: 20, stale: ["owner-1"] });
    deps.registry.findActiveByOwnerId.mockRejectedValue(new Error("boom"));
    const sweeper = makeSweeper(deps);

    sweeper.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(20_000);
    // second tick still runs — a rejected fence from the first tick must not
    // have thrown out of the interval callback and killed the timer.
    await vi.advanceTimersByTimeAsync(20_000);

    expect(deps.livenessStore.listStale).toHaveBeenCalledTimes(2);
  });

  it("onApplicationShutdown clears the interval so no further sweeps happen", async () => {
    const deps = makeDeps({ intervalSeconds: 20, stale: ["owner-1"] });
    const sweeper = makeSweeper(deps);

    sweeper.onApplicationBootstrap();
    sweeper.onApplicationShutdown();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(deps.livenessStore.listStale).not.toHaveBeenCalled();
  });

  it("onApplicationShutdown before bootstrap is a no-op", () => {
    const deps = makeDeps();
    const sweeper = makeSweeper(deps);

    expect(() => sweeper.onApplicationShutdown()).not.toThrow();
  });
});

describe("WorkerLivenessSweeper — fence flow", () => {
  // sweep() 是 private,借定时器触发一次 tick 来驱动 fence 流程,而不是反射调用私有方法。
  async function triggerSweep(deps: ReturnType<typeof makeDeps>) {
    vi.useFakeTimers();
    const sweeper = makeSweeper(deps);
    sweeper.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(
      deps.configService.getHeartbeatCheckIntervalSeconds() * 1000
    );
    vi.useRealTimers();
    return sweeper;
  }

  it("emits a WorkerLostEvent for every in-flight run registered for the stale owner", async () => {
    const deps = makeDeps({ stale: ["owner-1"] });
    deps.registry.findActiveByOwnerId.mockResolvedValue(
      activeRow({ ownerId: "owner-1" })
    );
    deps.ownerRunStore.runIdsForOwner.mockReturnValue(["run-1"]);

    await triggerSweep(deps);

    expect(deps.events.emit).toHaveBeenCalledWith(
      WORKER_LOST_EVENT,
      new WorkerLostEvent("run-1", "worker heartbeat timeout")
    );
  });

  it("full flow emits a WorkerLostEvent for every in-flight run, tears down the instance via the provisioner, and clears the liveness entry", async () => {
    const deps = makeDeps({ stale: ["owner-4"] });
    deps.registry.findActiveByOwnerId.mockResolvedValue(
      activeRow({ ownerId: "owner-4", instanceId: "container-4" })
    );
    deps.ownerRunStore.runIdsForOwner.mockReturnValue(["run-4a", "run-4b"]);

    await triggerSweep(deps);

    expect(deps.events.emit).toHaveBeenCalledWith(
      WORKER_LOST_EVENT,
      new WorkerLostEvent("run-4a", "worker heartbeat timeout")
    );
    expect(deps.events.emit).toHaveBeenCalledWith(
      WORKER_LOST_EVENT,
      new WorkerLostEvent("run-4b", "worker heartbeat timeout")
    );
    expect(deps.provisioner.stop).toHaveBeenCalledWith({
      runtimeType: "docker",
      ownerId: "owner-4",
      runtimeInstanceId: "container-4",
      isolationScope: "workspace",
    });
    expect(deps.livenessStore.remove).toHaveBeenCalledWith("owner-4");
  });

  it("builds the teardown ref from the active row's runtimeType (local)", async () => {
    const deps = makeDeps({ stale: ["owner-5"] });
    deps.registry.findActiveByOwnerId.mockResolvedValue(
      activeRow({
        ownerId: "owner-5",
        runtimeType: "local",
        instanceId: "4242:token",
      })
    );

    await triggerSweep(deps);

    expect(deps.provisioner.stop).toHaveBeenCalledWith({
      runtimeType: "local",
      ownerId: "owner-5",
      runtimeInstanceId: "4242:token",
      isolationScope: "workspace",
    });
  });

  it("no-ops when the owner has no active registry row", async () => {
    const deps = makeDeps({ stale: ["owner-gone"] });
    deps.registry.findActiveByOwnerId.mockResolvedValue(null);

    await triggerSweep(deps);

    expect(deps.events.emit).not.toHaveBeenCalled();
    expect(deps.provisioner.stop).not.toHaveBeenCalled();
    expect(deps.livenessStore.remove).not.toHaveBeenCalled();
  });
});
