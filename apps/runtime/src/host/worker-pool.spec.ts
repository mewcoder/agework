import { describe, it, expect, vi } from "vitest";
import {
  WorkerPool,
  type WorkerEntry,
  deriveReuseIdentity,
  reuseKey,
  type ReuseIdentity,
} from "./worker-pool.js";

const IDENTITY_WS: ReuseIdentity = {
  scope: "workspace",
  subjectId: "ws-1",
  runtimeType: "native",
};
const IDENTITY_USER: ReuseIdentity = {
  scope: "user",
  subjectId: "user-1",
  runtimeType: "docker",
};

function makeEntry(
  identity: ReuseIdentity,
  workerId = "worker-1",
  overrides: Partial<WorkerEntry> = {}
): WorkerEntry {
  return {
    workerId,
    isolation: {
      scope: identity.scope,
      subjectId: identity.subjectId,
    },
    runtimeType: identity.runtimeType,
    userId: "user-1",
    userLifecycleVersion: 1,
    // 默认空集——user-scope worker 只有显式 associateRun 后才关联 workspace
    workspaceIds: new Set<string>(),
    startToken: "token-1",
    status: "starting",
    runtimeInstanceId: "",
    lastSeen: 1000,
    cancelledRuns: new Set(),
    activeRuns: new Set(),
    ...overrides,
  };
}

describe("WorkerPool", () => {
  const noopCancel = () => {};

  it("deduplicates concurrent acquisitions for the same reuse identity", async () => {
    const pool = new WorkerPool();
    let resolve!: (entry: WorkerEntry) => void;
    const pending = new Promise<WorkerEntry>((done) => {
      resolve = done;
    });
    const acquire = vi.fn().mockReturnValue(pending);

    const first = pool.acquireOnce(IDENTITY_WS, 1, { userId: "user-1", workspaceId: "ws-1", cancel: noopCancel }, acquire);
    const second = pool.acquireOnce(IDENTITY_WS, 1, { userId: "user-1", workspaceId: "ws-1", cancel: noopCancel }, acquire);
    expect(second).toBe(first);
    expect(acquire).toHaveBeenCalledOnce();

    const entry = makeEntry(IDENTITY_WS);
    resolve(entry);
    await first;

    pool.put({ ...entry, status: "ready" });
    await expect(
      pool.acquireOnce(IDENTITY_WS, 1, { userId: "user-1", workspaceId: "ws-1", cancel: noopCancel }, acquire)
    ).resolves.toMatchObject({ workerId: entry.workerId });
    expect(acquire).toHaveBeenCalledOnce();
  });

  it("does not reuse a ready worker from a different userLifecycleVersion", async () => {
    const pool = new WorkerPool();
    const v1Entry = makeEntry(IDENTITY_WS, "worker-v1", {
      userLifecycleVersion: 1,
      status: "ready",
    });
    pool.put(v1Entry);

    // V2 submit should NOT reuse V1 worker
    let resolveV2!: (entry: WorkerEntry) => void;
    const v2Promise = new Promise<WorkerEntry>((done) => {
      resolveV2 = done;
    });
    const acquire = vi.fn().mockReturnValue(v2Promise);

    const result = pool.acquireOnce(
      IDENTITY_WS,
      2,
      { userId: "user-1", workspaceId: "ws-1", cancel: noopCancel },
      acquire
    );
    expect(acquire).toHaveBeenCalledOnce();

    const v2Entry = makeEntry(IDENTITY_WS, "worker-v2", {
      userLifecycleVersion: 2,
    });
    resolveV2(v2Entry);
    const resolved = await result;
    expect(resolved.workerId).toBe("worker-v2");
  });

  it("drainAcquisitions cancels and waits for matching acquisitions", async () => {
    const pool = new WorkerPool();
    let cancelCalled = false;
    let resolveAcq!: (entry: WorkerEntry) => void;
    const pending = new Promise<WorkerEntry>((done) => {
      resolveAcq = done;
    });
    const acquire = vi.fn().mockReturnValue(pending);

    pool.acquireOnce(
      IDENTITY_WS,
      1,
      { userId: "user-1", workspaceId: "ws-1", cancel: () => { cancelCalled = true; } },
      acquire
    );

    // Start drain — it should cancel and wait for the acquisition to settle
    const drainPromise = pool.drainAcquisitions((a) =>
      a.workspaceIds.has("ws-1")
    );
    expect(cancelCalled).toBe(true);

    // Acquisition hasn't settled yet
    let drained = false;
    drainPromise.then(() => { drained = true; });
    await Promise.resolve(); // microtask
    expect(drained).toBe(false);

    // Settle the acquisition (reject since it was cancelled)
    resolveAcq(makeEntry(IDENTITY_WS));
    await drainPromise;
    expect(drained).toBe(true);
  });

  it("enforces one entry per ReuseIdentity (同一 identity 至多一个 worker)", () => {
    const pool = new WorkerPool();
    pool.put(makeEntry(IDENTITY_WS, "worker-1"));
    pool.put(makeEntry(IDENTITY_WS, "worker-2"));

    expect(pool.list()).toHaveLength(1);
    expect(pool.getById("worker-2")).toBeDefined();
    expect(pool.getById("worker-1")).toBeUndefined();
  });

  it("supports multi-generation coexistence (不同 userLifecycleVersion 可短暂并存)", () => {
    const pool = new WorkerPool();
    // V1 worker
    pool.put(makeEntry(IDENTITY_WS, "worker-v1", { userLifecycleVersion: 1 }));
    // V2 worker — 不移除 V1,两代并存
    pool.put(makeEntry(IDENTITY_WS, "worker-v2", { userLifecycleVersion: 2 }));

    expect(pool.list()).toHaveLength(2);
    // V1 lookup returns V1 worker
    expect(pool.getByIdentity(IDENTITY_WS, 1)?.workerId).toBe("worker-v1");
    // V2 lookup returns V2 worker
    expect(pool.getByIdentity(IDENTITY_WS, 2)?.workerId).toBe("worker-v2");
    // V3 lookup returns undefined (不存在)
    expect(pool.getByIdentity(IDENTITY_WS, 3)).toBeUndefined();
  });

  it("removing one generation does not affect the other", () => {
    const pool = new WorkerPool();
    pool.put(makeEntry(IDENTITY_WS, "worker-v1", { userLifecycleVersion: 1 }));
    pool.put(makeEntry(IDENTITY_WS, "worker-v2", { userLifecycleVersion: 2 }));

    pool.remove("worker-v1");

    expect(pool.getById("worker-v1")).toBeUndefined();
    expect(pool.getById("worker-v2")).toBeDefined();
    expect(pool.getByIdentity(IDENTITY_WS, 1)).toBeUndefined();
    expect(pool.getByIdentity(IDENTITY_WS, 2)?.workerId).toBe("worker-v2");
  });

  it("getByIdentity looks up by structured ReuseIdentity", () => {
    const pool = new WorkerPool();
    pool.put(makeEntry(IDENTITY_WS, "worker-1"));

    expect(pool.getByIdentity(IDENTITY_WS, 1)?.workerId).toBe("worker-1");
    expect(pool.getByIdentity(IDENTITY_USER, 1)).toBeUndefined();
  });

  it("different runtimeType with same subject does not collide", () => {
    const pool = new WorkerPool();
    const dockerIdentity: ReuseIdentity = {
      scope: "workspace",
      subjectId: "ws-1",
      runtimeType: "docker",
    };
    pool.put(makeEntry(IDENTITY_WS, "worker-native"));
    pool.put(makeEntry(dockerIdentity, "worker-docker"));

    expect(pool.list()).toHaveLength(2);
    expect(pool.getByIdentity(IDENTITY_WS, 1)?.workerId).toBe("worker-native");
    expect(pool.getByIdentity(dockerIdentity, 1)?.workerId).toBe("worker-docker");
  });

  it("workspace scope and user scope with same subjectId do not collide", () => {
    const pool = new WorkerPool();
    // workspace:ws-1#native vs user:ws-1#native — different scope, no collision
    const userIdentity: ReuseIdentity = {
      scope: "user",
      subjectId: "ws-1",
      runtimeType: "native",
    };
    pool.put(makeEntry(IDENTITY_WS, "worker-ws"));
    pool.put(makeEntry(userIdentity, "worker-user"));

    expect(pool.list()).toHaveLength(2);
  });

  it("markReady flips status and records the runtime instance", () => {
    const pool = new WorkerPool();
    pool.put(makeEntry(IDENTITY_WS));
    pool.markReady("worker-1", "container-1");

    expect(pool.getById("worker-1")).toMatchObject({
      status: "ready",
      runtimeInstanceId: "container-1",
    });
  });

  it("routes runIds to their worker via associateRun/getByRunId", () => {
    const pool = new WorkerPool();
    pool.put(makeEntry(IDENTITY_WS));
    pool.associateRun("worker-1", "run-1");

    expect(pool.getByRunId("run-1")?.workerId).toBe("worker-1");

    pool.dissociateRun("run-1");
    expect(pool.getByRunId("run-1")).toBeUndefined();
    expect(pool.getById("worker-1")?.activeRuns.size).toBe(0);
  });

  it("remove clears the entry, its run index, and reuseIndex", () => {
    const pool = new WorkerPool();
    pool.put(makeEntry(IDENTITY_WS));
    pool.associateRun("worker-1", "run-1");

    const removed = pool.remove("worker-1");

    expect(removed?.workerId).toBe("worker-1");
    expect(pool.getById("worker-1")).toBeUndefined();
    expect(pool.getByIdentity(IDENTITY_WS, 1)).toBeUndefined();
    expect(pool.getByRunId("run-1")).toBeUndefined();
  });

  it("touch updates lastSeen for the fence", () => {
    const pool = new WorkerPool();
    pool.put(makeEntry(IDENTITY_WS));
    pool.touch("worker-1", 9999);

    expect(pool.getById("worker-1")?.lastSeen).toBe(9999);
  });

  it("markCancelled/consumeCancelled absorb pre-ready cancels exactly once", () => {
    const pool = new WorkerPool();
    pool.put(makeEntry(IDENTITY_WS));
    pool.markCancelled("worker-1", "run-1");

    expect(pool.consumeCancelled("worker-1", "run-1")).toBe(true);
    expect(pool.consumeCancelled("worker-1", "run-1")).toBe(false);
  });

  it("listByWorkspace filters workspace-scope workers by subjectId", () => {
    const pool = new WorkerPool();
    pool.put(makeEntry(IDENTITY_WS, "worker-1"));
    pool.put(makeEntry(IDENTITY_USER, "worker-2"));

    const owned = pool.listByWorkspace("ws-1");
    expect(owned.map((w) => w.workerId)).toEqual(["worker-1"]);
  });

  it("listByWorkspace also matches user-scope workers serving that workspace", () => {
    const pool = new WorkerPool();
    const userEntry = makeEntry(IDENTITY_USER, "worker-2");
    userEntry.workspaceIds.add("ws-1");
    pool.put(userEntry);
    pool.put(makeEntry(IDENTITY_WS, "worker-1"));

    const owned = pool.listByWorkspace("ws-1");
    expect(owned.map((w) => w.workerId).sort()).toEqual([
      "worker-1",
      "worker-2",
    ]);
  });

  it("listByUser filters all workers for a user (both scopes)", () => {
    const pool = new WorkerPool();
    pool.put(makeEntry(IDENTITY_WS, "worker-1", { userId: "user-1" }));
    pool.put(
      makeEntry(IDENTITY_USER, "worker-2", { userId: "user-1" })
    );
    pool.put(
      makeEntry(
        { scope: "workspace", subjectId: "ws-2", runtimeType: "native" },
        "worker-3",
        { userId: "user-2" }
      )
    );

    const owned = pool.listByUser("user-1");
    expect(owned.map((w) => w.workerId).sort()).toEqual([
      "worker-1",
      "worker-2",
    ]);
  });

  it("reuseKey produces distinct keys for different identities", () => {
    expect(reuseKey(IDENTITY_WS)).not.toBe(reuseKey(IDENTITY_USER));
    expect(reuseKey(IDENTITY_WS)).not.toBe(
      reuseKey({
        scope: "workspace",
        subjectId: "ws-10",
        runtimeType: "native",
      })
    );
  });

  it("deriveReuseIdentity: workspace scope → workspaceId, user scope → userId", () => {
    expect(
      deriveReuseIdentity({
        scope: "workspace",
        userId: "u1",
        workspaceId: "ws-1",
        runtimeType: "docker",
      })
    ).toEqual({
      scope: "workspace",
      subjectId: "ws-1",
      runtimeType: "docker",
    });
    expect(
      deriveReuseIdentity({
        scope: "user",
        userId: "u1",
        workspaceId: "ws-1",
        runtimeType: "docker",
      })
    ).toEqual({
      scope: "user",
      subjectId: "u1",
      runtimeType: "docker",
    });
  });
});
