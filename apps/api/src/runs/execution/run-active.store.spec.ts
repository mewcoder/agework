import { RunActiveStore, type RunHandle } from "./run-active.store";

describe("RunActiveStore", () => {
  it("registers, retrieves and unregisters a run handle", () => {
    const registry = new RunActiveStore();
    const handle: RunHandle = {
      runtimeHandle: { runId: "run-1", runtimeType: "local", runtimeInstanceId: "1:token", conversationId: "conversation-1" },
      res: null,
      aggregator: {} as any,
      conversationId: "conversation-1",
      runId: "run-1",
      workspaceId: "ws-1",
      agentType: "claude",
      stopRequested: false,
      saveRun: () => {},
    };

    registry.register("run-1", handle);
    expect(registry.get("run-1")).toBe(handle);

    registry.unregister("run-1");
    expect(registry.get("run-1")).toBeUndefined();
  });

  it("returns undefined for an unknown run id", () => {
    const registry = new RunActiveStore();
    expect(registry.get("missing")).toBeUndefined();
  });
});
