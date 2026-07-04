import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WorkerLivenessWatchdog } from "./worker-liveness.watchdog";

function makeDeps(
  overrides: {
    intervalSeconds?: number;
    timeoutSeconds?: number;
    stale?: string[];
  } = {}
) {
  const livenessStore = {
    listStale: vi.fn().mockReturnValue(overrides.stale ?? []),
  };
  const configService = {
    getHeartbeatCheckIntervalSeconds: vi
      .fn()
      .mockReturnValue(overrides.intervalSeconds ?? 20),
    getHeartbeatTimeoutSeconds: vi
      .fn()
      .mockReturnValue(overrides.timeoutSeconds ?? 75),
  };
  const workerManager = {
    fenceOwner: vi.fn().mockResolvedValue(undefined),
  };
  return { livenessStore, configService, workerManager };
}

describe("WorkerLivenessWatchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not sweep before the check interval elapses", async () => {
    const { livenessStore, configService, workerManager } = makeDeps({
      intervalSeconds: 20,
    });
    const watchdog = new WorkerLivenessWatchdog(
      livenessStore as never,
      configService as never,
      workerManager as never
    );

    watchdog.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(19_000);

    expect(livenessStore.listStale).not.toHaveBeenCalled();
  });

  it("sweeps on each interval tick and fences every stale owner", async () => {
    const { livenessStore, configService, workerManager } = makeDeps({
      intervalSeconds: 20,
      timeoutSeconds: 75,
      stale: ["owner-1", "owner-2"],
    });
    const watchdog = new WorkerLivenessWatchdog(
      livenessStore as never,
      configService as never,
      workerManager as never
    );

    watchdog.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(20_000);

    expect(livenessStore.listStale).toHaveBeenCalledWith(
      75_000,
      expect.any(Number)
    );
    expect(workerManager.fenceOwner).toHaveBeenCalledWith(
      "owner-1",
      expect.any(String)
    );
    expect(workerManager.fenceOwner).toHaveBeenCalledWith(
      "owner-2",
      expect.any(String)
    );
  });

  it("does not fence anyone when listStale returns no owners", async () => {
    const { livenessStore, configService, workerManager } = makeDeps({
      stale: [],
    });
    const watchdog = new WorkerLivenessWatchdog(
      livenessStore as never,
      configService as never,
      workerManager as never
    );

    watchdog.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(20_000);

    expect(workerManager.fenceOwner).not.toHaveBeenCalled();
  });

  it("keeps sweeping on subsequent ticks", async () => {
    const { livenessStore, configService, workerManager } = makeDeps({
      intervalSeconds: 20,
      stale: ["owner-1"],
    });
    const watchdog = new WorkerLivenessWatchdog(
      livenessStore as never,
      configService as never,
      workerManager as never
    );

    watchdog.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(20_000);
    await vi.advanceTimersByTimeAsync(20_000);

    expect(livenessStore.listStale).toHaveBeenCalledTimes(2);
  });

  it("swallows a fenceOwner rejection without breaking the interval", async () => {
    const { livenessStore, configService, workerManager } = makeDeps({
      intervalSeconds: 20,
      stale: ["owner-1"],
    });
    workerManager.fenceOwner.mockRejectedValue(new Error("boom"));
    const watchdog = new WorkerLivenessWatchdog(
      livenessStore as never,
      configService as never,
      workerManager as never
    );

    watchdog.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(20_000);
    // second tick still runs — a rejected fenceOwner from the first tick must
    // not have thrown out of the interval callback and killed the timer.
    await vi.advanceTimersByTimeAsync(20_000);

    expect(livenessStore.listStale).toHaveBeenCalledTimes(2);
  });

  it("onApplicationShutdown clears the interval so no further sweeps happen", async () => {
    const { livenessStore, configService, workerManager } = makeDeps({
      intervalSeconds: 20,
      stale: ["owner-1"],
    });
    const watchdog = new WorkerLivenessWatchdog(
      livenessStore as never,
      configService as never,
      workerManager as never
    );

    watchdog.onApplicationBootstrap();
    watchdog.onApplicationShutdown();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(livenessStore.listStale).not.toHaveBeenCalled();
  });

  it("onApplicationShutdown before bootstrap is a no-op", () => {
    const { livenessStore, configService, workerManager } = makeDeps();
    const watchdog = new WorkerLivenessWatchdog(
      livenessStore as never,
      configService as never,
      workerManager as never
    );

    expect(() => watchdog.onApplicationShutdown()).not.toThrow();
  });
});
