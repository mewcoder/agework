import { describe, it, expect, vi } from "vitest";
import { RunEventReceiverImpl } from "./run-event-receiver";
import type { RunEnvelopeProcessor } from "./run-envelope.processor";
import type { RunEventRecorder } from "../events/run-event-recorder";

function makeReceiver() {
  const processor = {
    publish: vi.fn().mockResolvedValue(undefined),
    isTerminalOrFinalizing: vi.fn().mockReturnValue(false),
    forceErrorStatus: vi.fn().mockResolvedValue(undefined),
    forceCancelledStatus: vi.fn().mockResolvedValue(undefined),
  };
  const recorder = {
    append: vi.fn().mockResolvedValue(undefined),
  };
  return {
    receiver: new RunEventReceiverImpl(
      processor as unknown as RunEnvelopeProcessor,
      recorder as unknown as RunEventRecorder
    ),
    processor,
    recorder,
  };
}

describe("RunEventReceiverImpl", () => {
  it("publish() delegates to processor", async () => {
    const { receiver, processor } = makeReceiver();
    const envelope = { runId: "run-1", seq: 1 } as never;
    await receiver.publish(envelope);
    expect(processor.publish).toHaveBeenCalledWith(envelope);
  });

  it("isTerminalOrFinalizing() delegates to processor", () => {
    const { receiver, processor } = makeReceiver();
    receiver.isTerminalOrFinalizing("run-1");
    expect(processor.isTerminalOrFinalizing).toHaveBeenCalledWith("run-1");
  });

  it("forceErrorStatus() delegates to processor", async () => {
    const { receiver, processor } = makeReceiver();
    await receiver.forceErrorStatus("run-1", "crashed");
    expect(processor.forceErrorStatus).toHaveBeenCalledWith("run-1", "crashed");
  });

  it("forceCancelledStatus() delegates to processor", async () => {
    const { receiver, processor } = makeReceiver();
    await receiver.forceCancelledStatus("run-1");
    expect(processor.forceCancelledStatus).toHaveBeenCalledWith("run-1");
  });

  it("recordCommandSent() records via recorder", async () => {
    const { receiver, recorder } = makeReceiver();
    await receiver.recordCommandSent({
      runId: "run-1",
      commandId: "cmd-1",
      commandType: "cancel",
    });
    expect(recorder.append).toHaveBeenCalledWith(
      expect.objectContaining({ type: "control.sent" })
    );
  });
});
