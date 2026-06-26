import { describe, it, expect, vi } from "vitest";
import { WorkerUpstreamAdapter } from "./worker-upstream.adapter";
import type { RunEnvelopeProcessor } from "../lifecycle/run-envelope.processor";
import type { RunActiveStore } from "../lifecycle/run-active.store";
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
});
