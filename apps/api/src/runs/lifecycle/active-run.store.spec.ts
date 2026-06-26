import { afterEach, describe, expect, it, vi } from "vitest";
import { RunActiveStore, type RunHandle } from "./run-active.store";
import type { ConfigService } from "../../config/config.service";

function makeConfig(timeoutSeconds = 60): ConfigService {
  return {
    getRunTimeoutSeconds: () => timeoutSeconds,
  } as ConfigService;
}

function makeHandle(runId = "run-1"): RunHandle {
  return {
    runtimeHandle: {
      runId,
      runtimeType: "local",
      runtimeInstanceId: "1:token",
      conversationId: "conversation-1",
    },
    res: null,
    aggregator: {} as any,
    conversationId: "conversation-1",
    runId,
    workspaceId: "ws-1",
    agentType: "claude",
    stopRequested: false,
    saveRun: () => {},
  };
}

describe("RunActiveStore", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("registers, retrieves and unregisters a run handle", () => {
    const registry = new RunActiveStore(makeConfig());
    const handle = makeHandle();

    registry.register("run-1", handle);
    expect(registry.get("run-1")).toBe(handle);

    registry.unregister("run-1");
    expect(registry.get("run-1")).toBeUndefined();
  });

  it("returns undefined for an unknown run id", () => {
    const registry = new RunActiveStore(makeConfig());
    expect(registry.get("missing")).toBeUndefined();
  });

  it("forces a run error after the configured timeout", async () => {
    vi.useFakeTimers();
    const markRunTimedOut = vi.fn().mockResolvedValue(undefined);
    const registry = new RunActiveStore(makeConfig(1));
    registry.setTimeoutErrorSink({ markRunTimedOut });

    const handle = makeHandle();
    registry.register("run-1", handle);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(markRunTimedOut).toHaveBeenCalledWith(
      "run-1",
      handle.runtimeHandle
    );
    registry.unregister("run-1");
  });

  it("clears the timeout when a run is unregistered", async () => {
    vi.useFakeTimers();
    const markRunTimedOut = vi.fn().mockResolvedValue(undefined);
    const registry = new RunActiveStore(makeConfig(1));
    registry.setTimeoutErrorSink({ markRunTimedOut });

    registry.register("run-1", makeHandle());
    registry.unregister("run-1");
    await vi.advanceTimersByTimeAsync(1_000);

    expect(markRunTimedOut).not.toHaveBeenCalled();
  });
});
