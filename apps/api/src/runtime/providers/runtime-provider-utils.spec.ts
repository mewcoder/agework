import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { HeartbeatWatchdog, resolveDockerApiBase } from "./runtime-provider-utils";

describe("HeartbeatWatchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not time out while heartbeats keep arriving", () => {
    const watchdog = new HeartbeatWatchdog();
    const onTimeout = vi.fn();
    watchdog.start("run-1", onTimeout);

    // Beat just before each check, for longer than the timeout window.
    for (let i = 0; i < 20; i++) {
      vi.advanceTimersByTime(5_000);
      watchdog.beat("run-1");
    }

    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("times out after no heartbeat for HEARTBEAT_TIMEOUT_MS", () => {
    const watchdog = new HeartbeatWatchdog();
    const onTimeout = vi.fn();
    watchdog.start("run-1", onTimeout);

    vi.advanceTimersByTime(65_000);

    expect(onTimeout).toHaveBeenCalled();
  });

  it("stops the timer so onTimeout is not called afterwards", () => {
    const watchdog = new HeartbeatWatchdog();
    const onTimeout = vi.fn();
    watchdog.start("run-1", onTimeout);
    watchdog.stop("run-1");

    vi.advanceTimersByTime(65_000);

    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("replaces an existing timer when started again for the same key", () => {
    const watchdog = new HeartbeatWatchdog();
    const onTimeout = vi.fn();
    watchdog.start("run-1", onTimeout);

    vi.advanceTimersByTime(55_000);
    watchdog.start("run-1", onTimeout);
    vi.advanceTimersByTime(10_000);

    expect(onTimeout).not.toHaveBeenCalled();

    vi.advanceTimersByTime(55_000);

    expect(onTimeout).toHaveBeenCalledTimes(1);
  });
});

describe("resolveDockerApiBase", () => {
  it("defaults to host.docker.internal with the api base path included", () => {
    expect(resolveDockerApiBase({})).toBe("http://host.docker.internal:3000/api/v1");
  });

  it("includes AGEWORK_CONTEXT in the path", () => {
    expect(resolveDockerApiBase({ AGEWORK_CONTEXT: "/agent" })).toBe(
      "http://host.docker.internal:3000/agent/api/v1"
    );
  });

  it("uses PORT when set", () => {
    expect(resolveDockerApiBase({ PORT: "4000" })).toBe(
      "http://host.docker.internal:4000/api/v1"
    );
  });


});
