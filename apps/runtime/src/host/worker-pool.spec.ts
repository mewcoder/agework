import { describe, it, expect, vi } from "vitest";
import type { WorkerKey } from "@agework/shared/protocol";
import { WorkerPool, type WorkerEntry } from "./worker-pool.js";

const KEY = "workspace:ws-1#native" as WorkerKey;
const OTHER_KEY = "user:user-1#docker" as WorkerKey;

function makeEntry(key: WorkerKey, workerId = "worker-1"): WorkerEntry {
  return {
    workerId,
    key,
    startToken: "token-1",
    status: "starting",
    runtimeInstanceId: "",
    lastSeen: 1000,
    cancelledRuns: new Set(),
    activeRuns: new Set(),
  };
}

describe("WorkerPool", () => {
  it("deduplicates concurrent acquisitions for the same worker key", async () => {
    const pool = new WorkerPool();
    let resolve!: (entry: WorkerEntry) => void;
    const pending = new Promise<WorkerEntry>((done) => {
      resolve = done;
    });
    const acquire = vi.fn().mockReturnValue(pending);

    const first = pool.acquireOnce(KEY, acquire);
    const second = pool.acquireOnce(KEY, acquire);
    expect(second).toBe(first);
    expect(acquire).toHaveBeenCalledOnce();

    const entry = makeEntry(KEY);
    resolve(entry);
    await first;

    pool.put({ ...entry, status: "ready" });
    await expect(
      pool.acquireOnce(KEY, acquire)
    ).resolves.toMatchObject({ workerId: entry.workerId });
    expect(acquire).toHaveBeenCalledOnce();
  });

  it("enforces one entry per WorkerKey (不变量 2)", () => {
    const pool = new WorkerPool();
    pool.put(makeEntry(KEY, "worker-1"));
    pool.put(makeEntry(KEY, "worker-2"));

    expect(pool.list()).toHaveLength(1);
    expect(pool.get(KEY)?.workerId).toBe("worker-2");
  });

  it("markReady flips status and records the runtime instance", () => {
    const pool = new WorkerPool();
    pool.put(makeEntry(KEY));
    pool.markReady(KEY, "container-1");

    expect(pool.get(KEY)).toMatchObject({
      status: "ready",
      runtimeInstanceId: "container-1",
    });
  });

  it("routes runIds to their worker via associateRun/getByRunId", () => {
    const pool = new WorkerPool();
    pool.put(makeEntry(KEY));
    pool.associateRun(KEY, "run-1");

    expect(pool.getByRunId("run-1")?.key).toBe(KEY);

    pool.dissociateRun("run-1");
    expect(pool.getByRunId("run-1")).toBeUndefined();
    expect(pool.get(KEY)?.activeRuns.size).toBe(0);
  });

  it("remove clears the entry and its run index", () => {
    const pool = new WorkerPool();
    pool.put(makeEntry(KEY));
    pool.associateRun(KEY, "run-1");

    const removed = pool.remove(KEY);

    expect(removed?.workerId).toBe("worker-1");
    expect(pool.get(KEY)).toBeUndefined();
    expect(pool.getByRunId("run-1")).toBeUndefined();
  });

  it("touch updates lastSeen for the fence", () => {
    const pool = new WorkerPool();
    pool.put(makeEntry(KEY));
    pool.touch(KEY, 9999);

    expect(pool.get(KEY)?.lastSeen).toBe(9999);
  });

  it("markCancelled/consumeCancelled absorb pre-ready cancels exactly once", () => {
    const pool = new WorkerPool();
    pool.put(makeEntry(KEY));
    pool.markCancelled(KEY, "run-1");

    expect(pool.consumeCancelled(KEY, "run-1")).toBe(true);
    expect(pool.consumeCancelled(KEY, "run-1")).toBe(false);
  });

  it("listByOwner filters by OwnerKey (releaseOwner)", () => {
    const pool = new WorkerPool();
    pool.put(makeEntry(KEY, "worker-1"));
    pool.put(makeEntry(OTHER_KEY, "worker-2"));

    const owned = pool.listByOwner("workspace:ws-1");

    expect(owned.map((w) => w.workerId)).toEqual(["worker-1"]);
  });

  it("listByOwner does not match owners sharing a plain string prefix (ws-1 vs ws-10)", () => {
    const pool = new WorkerPool();
    pool.put(makeEntry(KEY, "worker-1"));
    pool.put(makeEntry("workspace:ws-10#native" as WorkerKey, "worker-10"));

    const owned = pool.listByOwner("workspace:ws-1");

    expect(owned.map((w) => w.workerId)).toEqual(["worker-1"]);
    expect(pool.listByOwner("workspace:ws-10").map((w) => w.workerId)).toEqual([
      "worker-10",
    ]);
  });
});
