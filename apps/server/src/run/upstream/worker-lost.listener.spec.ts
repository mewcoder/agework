import { describe, it, expect, vi } from "vitest";
import { WorkerLostListener } from "./worker-lost.listener";
import { WorkerLostEvent } from "../../worker-manager/worker-manager.events";

function makeListener() {
  const workerEvents = {
    notifyWorkerLost: vi.fn().mockResolvedValue(undefined),
  };
  const listener = new WorkerLostListener(workerEvents as never);
  return { listener, workerEvents };
}

describe("WorkerLostListener", () => {
  it("forwards the event to WorkerEventService.notifyWorkerLost", async () => {
    const { listener, workerEvents } = makeListener();

    await listener.onWorkerLost(
      new WorkerLostEvent("run-1", "worker heartbeat timeout")
    );

    expect(workerEvents.notifyWorkerLost).toHaveBeenCalledWith(
      "run-1",
      "worker heartbeat timeout"
    );
  });

  it("swallows a notifyWorkerLost rejection instead of throwing", async () => {
    const { listener, workerEvents } = makeListener();
    workerEvents.notifyWorkerLost.mockRejectedValue(
      new Error("run already gone")
    );

    await expect(
      listener.onWorkerLost(new WorkerLostEvent("run-1", "reason"))
    ).resolves.toBeUndefined();
  });
});
