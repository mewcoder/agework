import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WorkerLivenessStore } from "./worker-liveness.store";

describe("WorkerLivenessStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("touch records the current time and lastSeenAt returns it", () => {
    const store = new WorkerLivenessStore();
    vi.setSystemTime(1000);

    store.touch("owner-1");

    expect(store.lastSeenAt("owner-1")).toBe(1000);
  });

  it("touch on an existing owner overwrites the previous timestamp", () => {
    const store = new WorkerLivenessStore();
    vi.setSystemTime(1000);
    store.touch("owner-1");
    vi.setSystemTime(2000);

    store.touch("owner-1");

    expect(store.lastSeenAt("owner-1")).toBe(2000);
  });

  it("lastSeenAt returns undefined for an owner never touched", () => {
    const store = new WorkerLivenessStore();
    expect(store.lastSeenAt("owner-never")).toBeUndefined();
  });

  it("remove stops tracking the owner", () => {
    const store = new WorkerLivenessStore();
    vi.setSystemTime(1000);
    store.touch("owner-1");

    store.remove("owner-1");

    expect(store.lastSeenAt("owner-1")).toBeUndefined();
  });

  it("remove on an owner that was never touched is a no-op", () => {
    const store = new WorkerLivenessStore();
    expect(() => store.remove("owner-never")).not.toThrow();
  });

  it("listStale returns owners whose last-seen time is older than the threshold", () => {
    const store = new WorkerLivenessStore();
    vi.setSystemTime(0);
    store.touch("stale-owner");
    vi.setSystemTime(50_000);
    store.touch("fresh-owner");

    const now = 100_000;
    const stale = store.listStale(75_000, now);

    expect(stale).toEqual(["stale-owner"]);
  });

  it("listStale excludes an owner exactly at the threshold boundary (not yet stale)", () => {
    const store = new WorkerLivenessStore();
    vi.setSystemTime(25_000);
    store.touch("owner-1");

    // now - threshold === seenAt -> not strictly earlier than cutoff
    const stale = store.listStale(75_000, 100_000);

    expect(stale).toEqual([]);
  });

  it("an ownerId never touched never appears in listStale, no matter the threshold/now", () => {
    const store = new WorkerLivenessStore();
    vi.setSystemTime(0);
    store.touch("known-owner");

    const stale = store.listStale(0, 10_000_000);

    expect(stale).toEqual(["known-owner"]);
    expect(stale).not.toContain("never-touched-owner");
  });
});
