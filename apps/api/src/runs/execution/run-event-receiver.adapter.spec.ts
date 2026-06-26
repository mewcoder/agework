import { describe, it, expect, vi } from "vitest";
import { RunEventReceiverAdapter } from "./run-event-receiver.adapter";
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
    receiver: new RunEventReceiverAdapter(
      processor as unknown as RunEnvelopeProcessor,
      recorder as unknown as RunEventRecorder
    ),
    processor,
    recorder,
  };
}

describe("RunEventReceiverAdapter", () => {
  it("publish() delegates to processor", async () => {
    const { receiver, processor } = makeReceiver();
    const envelope = { runId: "run-1", seq: 1 } as never;
    await receiver.publish(envelope);
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

  it("recordCommandSent() records via recorder", async () => {
    const { receiver, recorder } = makeReceiver();
    await receiver.recordCommandSent({
      runId: "run-1",
      commandId: "cmd-1",
      commandType: "cancel",
    });
    expect(recorder.append).toHaveBeenCalledWith(
      expect.objectContaining({ type: "command.sent" })
    );
  });
});
