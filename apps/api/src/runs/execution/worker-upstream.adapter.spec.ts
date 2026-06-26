import { describe, it, expect, vi } from "vitest";
import { WorkerUpstreamAdapter } from "./worker-upstream.adapter";
import type { RunEnvelopeProcessor } from "./run-envelope.processor";
import type { RunActiveStore } from "./run-active.store";
import type { RunDriver } from "./run-driver";

const activeHandle = {
  runtimeHandle: {
    runId: "run-1",
    runtimeType: "docker",
    runtimeInstanceId: "container-abc",
    conversationId: "conversation-1",
  },
};

function makeAdapter(opts: {
  handle: unknown;
  runDriver: Partial<RunDriver>;
}) {
  const runEventProcessor: Partial<RunEnvelopeProcessor> = {
    publish: vi.fn().mockResolvedValue(undefined),
  };
  const runRegistry: Partial<RunActiveStore> = {
    get: vi.fn().mockReturnValue(opts.handle),
  };
  const adapter = new WorkerUpstreamAdapter(
    runEventProcessor as RunEnvelopeProcessor,
    runRegistry as RunActiveStore,
    opts.runDriver as RunDriver
  );
  return { adapter, runEventProcessor };
}

describe("WorkerUpstreamAdapter", () => {
  it("publishes every envelope to RunEnvelopeProcessor", async () => {
    const { adapter, runEventProcessor } = makeAdapter({
      handle: activeHandle,
      runDriver: {},
    });

    const envelope = {
      runId: "run-1",
      seq: 1,
      type: "agui.event",
      payload: {},
      ts: new Date().toISOString(),
    };
    await adapter.ingestEvent("run-1", envelope);

    expect(runEventProcessor.publish).toHaveBeenCalledWith(envelope);
  });

  it("cleans up via RunDriver on terminal status", async () => {
    const runDriver: Partial<RunDriver> = { cleanup: vi.fn() };
    const { adapter } = makeAdapter({ handle: activeHandle, runDriver });

    await adapter.ingestEvent("run-1", {
      runId: "run-1",
      seq: 1,
      type: "run.status",
      payload: { status: "finished" },
      ts: new Date().toISOString(),
    });

    expect(runDriver.cleanup).toHaveBeenCalledWith(activeHandle.runtimeHandle);
  });

  it("does not call cleanup for non-terminal run.status", async () => {
    const runDriver: Partial<RunDriver> = { cleanup: vi.fn() };
    const { adapter } = makeAdapter({ handle: activeHandle, runDriver });

    await adapter.ingestEvent("run-1", {
      runId: "run-1",
      seq: 1,
      type: "run.status",
      payload: { status: "running" },
      ts: new Date().toISOString(),
    });

    expect(runDriver.cleanup).not.toHaveBeenCalled();
  });

  it("feeds the heartbeat watchdog via RunDriver on heartbeat events", async () => {
    const runDriver: Partial<RunDriver> = { heartbeat: vi.fn() };
    const { adapter } = makeAdapter({ handle: activeHandle, runDriver });

    await adapter.ingestEvent("run-1", {
      runId: "run-1",
      seq: 1,
      type: "heartbeat",
      payload: { at: new Date().toISOString() },
      ts: new Date().toISOString(),
    });

    expect(runDriver.heartbeat).toHaveBeenCalledWith(activeHandle.runtimeHandle);
  });

  it("does not feed heartbeat when no run handle is registered", async () => {
    const runDriver: Partial<RunDriver> = { heartbeat: vi.fn() };
    const { adapter } = makeAdapter({ handle: undefined, runDriver });

    await adapter.ingestEvent("run-1", {
      runId: "run-1",
      seq: 1,
      type: "heartbeat",
      payload: { at: new Date().toISOString() },
      ts: new Date().toISOString(),
    });

    expect(runDriver.heartbeat).not.toHaveBeenCalled();
  });
});
