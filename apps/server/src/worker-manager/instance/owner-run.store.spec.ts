import { describe, it, expect } from "vitest";
import { OwnerRunStore } from "./owner-run.store";

describe("OwnerRunStore", () => {
  it("returns runIds registered for a worker", () => {
    const store = new OwnerRunStore();
    store.registerRun("run-1", "worker-1");
    store.registerRun("run-2", "worker-1");

    expect(store.listRunIdsByWorkerId("worker-1").sort()).toEqual([
      "run-1",
      "run-2",
    ]);
  });

  it("returns an empty list for a worker with no registered runs", () => {
    const store = new OwnerRunStore();
    expect(store.listRunIdsByWorkerId("worker-none")).toEqual([]);
  });

  it("unregisterRun removes only the given run from its worker", () => {
    const store = new OwnerRunStore();
    store.registerRun("run-1", "worker-1");
    store.registerRun("run-2", "worker-1");

    store.unregisterRun("run-1");

    expect(store.listRunIdsByWorkerId("worker-1")).toEqual(["run-2"]);
  });

  it("drops the worker entry once its last run is unregistered", () => {
    const store = new OwnerRunStore();
    store.registerRun("run-1", "worker-1");

    store.unregisterRun("run-1");

    expect(store.listRunIdsByWorkerId("worker-1")).toEqual([]);
  });

  it("unregisterRun on an unknown runId is a no-op", () => {
    const store = new OwnerRunStore();
    expect(() => store.unregisterRun("run-unknown")).not.toThrow();
  });

  it("findWorkerIdByRunId looks up the worker registered for a run", () => {
    const store = new OwnerRunStore();
    store.registerRun("run-1", "worker-1");

    expect(store.findWorkerIdByRunId("run-1")).toBe("worker-1");
  });

  it("findWorkerIdByRunId returns undefined for an unknown or unregistered run", () => {
    const store = new OwnerRunStore();
    store.registerRun("run-1", "worker-1");
    store.unregisterRun("run-1");

    expect(store.findWorkerIdByRunId("run-1")).toBeUndefined();
    expect(store.findWorkerIdByRunId("run-unknown")).toBeUndefined();
  });
});
