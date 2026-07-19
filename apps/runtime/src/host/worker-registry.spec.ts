import { describe, expect, it } from "vitest";
import { WorkerRegistry } from "./worker-registry";
import type { WorkerEntry } from "./worker-pool";

function makeEntry(workerId = "worker-1"): WorkerEntry {
  return {
    workerId,
    isolation: { scope: "workspace", subjectId: "workspace-1" },
    runtimeType: "native",
    userId: "user-1",
    userLifecycleVersion: 1,
    workspaceIds: new Set(["workspace-1"]),
    startToken: "token-1",
    status: "starting",
    runtimeInstanceId: "",
    lastSeen: Date.now(),
    cancelledRuns: new Set(),
    activeRuns: new Set(["run-1"]),
  };
}

describe("WorkerRegistry", () => {
  it("evicts the entry, pending handshake and command queue together", async () => {
    const registry = new WorkerRegistry();
    const entry = makeEntry();
    registry.put(entry);
    const handshake = registry.waitForRegister(
      entry.workerId,
      entry.startToken
    );
    registry.enqueueCommand(entry.workerId, "run-1", {
      type: "user_message",
      commandId: "command-1",
      runId: "run-1",
    });

    const rejected = expect(handshake).rejects.toThrow("worker stopped");
    expect(registry.evict(entry.workerId, "worker stopped")).toBe(entry);
    await rejected;

    expect(registry.getById(entry.workerId)).toBeUndefined();
    await expect(
      registry.pollCommands(entry.workerId, 0, 0)
    ).resolves.toEqual([]);
  });

  it("cleans control state when a worker generation is superseded", async () => {
    const registry = new WorkerRegistry();
    const first = makeEntry("worker-1");
    registry.put(first);
    const handshake = registry.waitForRegister(
      first.workerId,
      first.startToken
    );
    const rejected = expect(handshake).rejects.toThrow("worker superseded");

    registry.put(makeEntry("worker-2"));

    await rejected;
    expect(registry.getById("worker-1")).toBeUndefined();
    expect(registry.getById("worker-2")).toBeDefined();
  });
});
