import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ConfigService } from "../../config/config.service";
import { RuntimeLivenessWatchdog } from "./runtime-liveness.watchdog";

describe("RuntimeLivenessWatchdog", () => {
  const repository = {
    markStaleOnlineAsOffline: vi.fn().mockResolvedValue(0),
  };
  const configService = {
    getHeartbeatCheckIntervalSeconds: vi.fn().mockReturnValue(10),
    getHeartbeatTimeoutSeconds: vi.fn().mockReturnValue(30),
  } as unknown as ConfigService;
  let watchdog: RuntimeLivenessWatchdog;

  beforeEach(() => {
    vi.useFakeTimers();
    repository.markStaleOnlineAsOffline.mockClear();
    watchdog = new RuntimeLivenessWatchdog(repository as never, configService);
  });

  afterEach(() => {
    watchdog.onApplicationShutdown();
    vi.useRealTimers();
  });

  it("sweeps stale online runtimes on each interval with the timeout cutoff", async () => {
    const now = new Date("2026-07-04T00:10:00Z").getTime();
    vi.setSystemTime(now);
    watchdog.onApplicationBootstrap();

    await vi.advanceTimersByTimeAsync(10_000);

    expect(repository.markStaleOnlineAsOffline).toHaveBeenCalledTimes(1);
    const cutoff = repository.markStaleOnlineAsOffline.mock.calls[0][0] as Date;
    expect(cutoff.getTime()).toBe(now + 10_000 - 30_000);
  });

  it("stops sweeping after shutdown", async () => {
    watchdog.onApplicationBootstrap();
    watchdog.onApplicationShutdown();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(repository.markStaleOnlineAsOffline).not.toHaveBeenCalled();
  });
});
