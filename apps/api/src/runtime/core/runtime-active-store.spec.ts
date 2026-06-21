import { RuntimeActiveStore, type RunHandle } from "./runtime-active-store";

describe("RuntimeActiveStore", () => {
  it("registers, retrieves and unregisters a run handle", () => {
    const registry = new RuntimeActiveStore();
    const handle: RunHandle = {
      runtimeHandle: { runId: "run-1", runtimeType: "local", runtimeResourceId: "1:token", conversationId: "conversation-1" },
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
    const registry = new RuntimeActiveStore();
    expect(registry.get("missing")).toBeUndefined();
  });
});
