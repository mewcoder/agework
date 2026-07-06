import { describe, it, expect } from "vitest";
import { LiveCarrierStore } from "./registry.js";

describe("LiveCarrierStore", () => {
  it("records and retrieves a carrier by ownerId", () => {
    const store = new LiveCarrierStore();
    store.record("owner-1", {
      runtimeInstanceId: "container-1",
      isolationScope: "workspace",
    });
    expect(store.get("owner-1")).toEqual({
      runtimeInstanceId: "container-1",
      isolationScope: "workspace",
    });
  });

  it("returns undefined for an unknown owner", () => {
    const store = new LiveCarrierStore();
    expect(store.get("unknown")).toBeUndefined();
  });

  it("remove clears the record", () => {
    const store = new LiveCarrierStore();
    store.record("owner-1", {
      runtimeInstanceId: "container-1",
      isolationScope: "workspace",
    });
    store.remove("owner-1");
    expect(store.get("owner-1")).toBeUndefined();
  });

  it("list reflects all recorded carriers", () => {
    const store = new LiveCarrierStore();
    store.record("owner-1", {
      runtimeInstanceId: "c1",
      isolationScope: "workspace",
    });
    store.record("owner-2", { runtimeInstanceId: "c2", isolationScope: "user" });
    expect(store.list().size).toBe(2);
    expect(store.list().get("owner-2")).toEqual({
      runtimeInstanceId: "c2",
      isolationScope: "user",
    });
  });
});
