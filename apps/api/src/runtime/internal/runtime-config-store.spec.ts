import { describe, it, expect } from "vitest";
import { RuntimeConfigStore } from "./runtime-config-store";

describe("RuntimeConfigStore", () => {
  it("registers, retrieves and unregisters a run config", () => {
    const store = new RuntimeConfigStore();
    const config = { runId: "run-1" } as any;

    store.register("run-1", config);
    expect(store.get("run-1")).toBe(config);

    store.unregister("run-1");
    expect(store.get("run-1")).toBeUndefined();
  });

  it("returns undefined for an unknown run id", () => {
    const store = new RuntimeConfigStore();
    expect(store.get("missing")).toBeUndefined();
  });

  it("unregister is idempotent", () => {
    const store = new RuntimeConfigStore();
    store.unregister("nonexistent"); // should not throw
    expect(store.get("nonexistent")).toBeUndefined();
  });
});
