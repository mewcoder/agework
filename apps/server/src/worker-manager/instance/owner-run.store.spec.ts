import { describe, it, expect } from "vitest";
import { OwnerRunStore } from "./owner-run.store";

describe("OwnerRunStore", () => {
  it("returns runIds registered for an owner", () => {
    const store = new OwnerRunStore();
    store.registerRun("run-1", "owner-1");
    store.registerRun("run-2", "owner-1");

    expect(store.listRunIdsByOwnerId("owner-1").sort()).toEqual([
      "run-1",
      "run-2",
    ]);
  });

  it("returns an empty list for an owner with no registered runs", () => {
    const store = new OwnerRunStore();
    expect(store.listRunIdsByOwnerId("owner-none")).toEqual([]);
  });

  it("unregisterRun removes only the given run from its owner", () => {
    const store = new OwnerRunStore();
    store.registerRun("run-1", "owner-1");
    store.registerRun("run-2", "owner-1");

    store.unregisterRun("run-1");

    expect(store.listRunIdsByOwnerId("owner-1")).toEqual(["run-2"]);
  });

  it("drops the owner entry once its last run is unregistered", () => {
    const store = new OwnerRunStore();
    store.registerRun("run-1", "owner-1");

    store.unregisterRun("run-1");

    expect(store.listRunIdsByOwnerId("owner-1")).toEqual([]);
  });

  it("unregisterRun on an unknown runId is a no-op", () => {
    const store = new OwnerRunStore();
    expect(() => store.unregisterRun("run-unknown")).not.toThrow();
  });

  it("findOwnerIdByRunId looks up the owner registered for a run", () => {
    const store = new OwnerRunStore();
    store.registerRun("run-1", "owner-1");

    expect(store.findOwnerIdByRunId("run-1")).toBe("owner-1");
  });

  it("findOwnerIdByRunId returns undefined for an unknown or unregistered run", () => {
    const store = new OwnerRunStore();
    store.registerRun("run-1", "owner-1");
    store.unregisterRun("run-1");

    expect(store.findOwnerIdByRunId("run-1")).toBeUndefined();
    expect(store.findOwnerIdByRunId("run-unknown")).toBeUndefined();
  });
});
