import { describe, it, expect } from "vitest";
import { WorkerConfigStore } from "./config-store";

describe("WorkerConfigStore", () => {
  it("registers, retrieves and unregisters a run config", () => {
    const store = new WorkerConfigStore();
    const config = { runId: "run-1" } as any;

    store.register("run-1", config);
    expect(store.get("run-1")).toBe(config);

    store.unregister("run-1");
    expect(store.get("run-1")).toBeUndefined();
  });

  it("returns undefined for an unknown run id", () => {
    const store = new WorkerConfigStore();
    expect(store.get("missing")).toBeUndefined();
  });

  it("unregister is idempotent", () => {
    const store = new WorkerConfigStore();
    store.unregister("nonexistent"); // should not throw
    expect(store.get("nonexistent")).toBeUndefined();
  });
});
