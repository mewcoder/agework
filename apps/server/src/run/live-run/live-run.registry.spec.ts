import { afterEach, describe, expect, it, vi } from "vitest";
import { LiveRunRegistry, type LiveRunHandle } from "./live-run.registry";
import type { ConfigService } from "../../config/config.service";
import { RunStream } from "../streaming/run-stream";

function makeConfig(timeoutSeconds = 60): ConfigService {
  return {
    getRunTimeoutSeconds: () => timeoutSeconds,
  } as ConfigService;
}

function makeHandle(runId = "run-1"): LiveRunHandle {
  return {
    runtimeHandle: {
      runId,
      runtimeType: "native",
      runtimeInstanceId: "1:token",
      conversationId: "conversation-1",
    },
    stream: new RunStream({
      setHeader: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
      writableEnded: false,
      on: vi.fn(),
      status: vi.fn(),
    } as any),
    aggregator: {} as any,
    conversationId: "conversation-1",
    runId,
    workspaceId: "ws-1",
    agentType: "claude",
    stopRequested: false,
    saveRun: () => {},
  };
}

describe("LiveRunRegistry", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("registers, retrieves and unregisters a run handle", () => {
    const registry = new LiveRunRegistry(makeConfig());
    const handle = makeHandle();

    registry.register("run-1", handle);
    expect(registry.get("run-1")).toBe(handle);

    registry.unregister("run-1");
    expect(registry.get("run-1")).toBeUndefined();
  });

  it("returns undefined for an unknown run id", () => {
    const registry = new LiveRunRegistry(makeConfig());
    expect(registry.get("missing")).toBeUndefined();
  });

  it("forces a run error after the configured timeout", async () => {
    vi.useFakeTimers();
    const markRunTimedOut = vi.fn().mockResolvedValue(undefined);
    const registry = new LiveRunRegistry(makeConfig(1));
    registry.setTimeoutErrorPort({ markRunTimedOut });

    const handle = makeHandle();
    registry.register("run-1", handle);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(markRunTimedOut).toHaveBeenCalledWith("run-1", handle.runtimeHandle);
    registry.unregister("run-1");
  });

  it("clears the timeout when a run is unregistered", async () => {
    vi.useFakeTimers();
    const markRunTimedOut = vi.fn().mockResolvedValue(undefined);
    const registry = new LiveRunRegistry(makeConfig(1));
    registry.setTimeoutErrorPort({ markRunTimedOut });

    registry.register("run-1", makeHandle());
    registry.unregister("run-1");
    await vi.advanceTimersByTimeAsync(1_000);

    expect(markRunTimedOut).not.toHaveBeenCalled();
  });

  it("clears all timeout timers on application shutdown", async () => {
    vi.useFakeTimers();
    const markRunTimedOut = vi.fn().mockResolvedValue(undefined);
    const registry = new LiveRunRegistry(makeConfig(1));
    registry.setTimeoutErrorPort({ markRunTimedOut });

    registry.register("run-1", makeHandle("run-1"));
    registry.register("run-2", makeHandle("run-2"));
    registry.onApplicationShutdown();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(markRunTimedOut).not.toHaveBeenCalled();
  });
});
