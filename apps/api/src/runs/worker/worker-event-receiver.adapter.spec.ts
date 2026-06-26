import { describe, it, expect, vi } from "vitest";
import { WorkerEventReceiverAdapter } from "./worker-event-receiver.adapter";
import type { RunEnvelopeProcessor } from "./run-envelope.processor";
import { RunEventService } from "../events/run-event.service";
import type { ActiveRunRegistry } from "../lifecycle/active-run.registry";
import type { RunDriver } from "./run-driver";

const activeHandle = {
  runtimeHandle: {
    runId: "run-1",
    runtimeType: "sandbox",
    runtimeInstanceId: "container-abc",
    conversationId: "conversation-1",
  },
} as const;

function makeReceiver(opts: {
  handle?: unknown;
  runDriver?: Partial<RunDriver>;
} = {}) {
  const processor = {
    publish: vi.fn().mockResolvedValue(undefined),
    isTerminalOrFinalizing: vi.fn().mockReturnValue(false),
    forceErrorStatus: vi.fn().mockResolvedValue(undefined),
    forceCancelledStatus: vi.fn().mockResolvedValue(undefined),
  };
  const runEvents = new RunEventService({} as never);
  vi.spyOn(runEvents, "append").mockResolvedValue(undefined as never);
  const activeRuns: Partial<ActiveRunRegistry> = {
    get: vi.fn().mockReturnValue(opts.handle),
  };
  const runDriver: Partial<RunDriver> = {
    cleanup: vi.fn(),
    ...opts.runDriver,
  };

  return {
    receiver: new WorkerEventReceiverAdapter(
      processor as unknown as RunEnvelopeProcessor,
      runEvents,
      activeRuns as ActiveRunRegistry,
      runDriver as RunDriver
    ),
    processor,
    runEvents,
    activeRuns,
    runDriver,
  };
}

describe("WorkerEventReceiverAdapter", () => {
  it("sendEvent() delegates envelope to processor", async () => {
    const { receiver, processor } = makeReceiver();
    const envelope = { runId: "run-1", seq: 1 } as never;
    await receiver.sendEvent("run-1", envelope);
    expect(processor.publish).toHaveBeenCalledWith(envelope);
  });

  it("notifyWorkerError() skips when run already terminal/finalizing", async () => {
    const { receiver, processor } = makeReceiver();
    processor.isTerminalOrFinalizing.mockReturnValue(true);

    await receiver.notifyWorkerError("run-1", "crashed");

    expect(processor.forceErrorStatus).not.toHaveBeenCalled();
  });

  it("notifyWorkerError() forces error status when run not terminal", async () => {
    const { receiver, processor } = makeReceiver();
    processor.isTerminalOrFinalizing.mockReturnValue(false);

    await receiver.notifyWorkerError("run-1", "crashed");

    expect(processor.forceErrorStatus).toHaveBeenCalledWith("run-1", "crashed");
  });

  it("notifyCancelledBeforeReady() skips when run already terminal/finalizing", async () => {
    const { receiver, processor } = makeReceiver();
    processor.isTerminalOrFinalizing.mockReturnValue(true);

    await receiver.notifyCancelledBeforeReady("run-1");

    expect(processor.forceCancelledStatus).not.toHaveBeenCalled();
  });

  it("notifyCancelledBeforeReady() forces cancelled when run not terminal", async () => {
    const { receiver, processor } = makeReceiver();
    processor.isTerminalOrFinalizing.mockReturnValue(false);

    await receiver.notifyCancelledBeforeReady("run-1");

    expect(processor.forceCancelledStatus).toHaveBeenCalledWith("run-1");
  });

  it("recordCommandSent() records via run event service", async () => {
    const { receiver, runEvents } = makeReceiver();
    await receiver.recordCommandSent({
      runId: "run-1",
      commandId: "cmd-1",
      commandType: "cancel",
    });
    expect(runEvents.append).toHaveBeenCalledWith(
      expect.objectContaining({ type: "command.sent" })
    );
  });

  it("sendEvent() accepts HTTP event", async () => {
    const { receiver, processor } = makeReceiver({ handle: activeHandle });

    const envelope = {
      runId: "run-1",
      seq: 1,
      type: "agui.event",
      payload: {},
      ts: new Date().toISOString(),
    };
    await receiver.sendEvent("run-1", envelope);

    expect(processor.publish).toHaveBeenCalledWith(envelope);
  });

  it("sendEvent() cleans up via RunDriver on terminal status", async () => {
    const runDriver: Partial<RunDriver> = { cleanup: vi.fn() };
    const { receiver } = makeReceiver({
      handle: activeHandle,
      runDriver,
    });

    await receiver.sendEvent("run-1", {
      runId: "run-1",
      seq: 1,
      type: "run.status",
      payload: { status: "finished" },
      ts: new Date().toISOString(),
    });

    expect(runDriver.cleanup).toHaveBeenCalledWith(activeHandle.runtimeHandle);
  });

  it("sendEvent() does not call cleanup for non-terminal run.status", async () => {
    const runDriver: Partial<RunDriver> = { cleanup: vi.fn() };
    const { receiver } = makeReceiver({
      handle: activeHandle,
      runDriver,
    });

    await receiver.sendEvent("run-1", {
      runId: "run-1",
      seq: 1,
      type: "run.status",
      payload: { status: "running" },
      ts: new Date().toISOString(),
    });

    expect(runDriver.cleanup).not.toHaveBeenCalled();
  });
});
