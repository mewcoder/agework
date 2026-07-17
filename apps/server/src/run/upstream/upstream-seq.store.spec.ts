import { describe, expect, it } from "vitest";
import { UpstreamSeqStore } from "./upstream-seq.store";

describe("UpstreamSeqStore", () => {
  it("accepts, drops duplicates, reports gaps and forgets runs", () => {
    const store = new UpstreamSeqStore();

    expect(store.accept("run-1", 1)).toEqual({
      action: "accept",
      lastSeq: 0,
      gap: undefined,
    });
    expect(store.accept("run-1", 1)).toEqual({
      action: "drop",
      lastSeq: 1,
    });
    expect(store.accept("run-1", 3)).toEqual({
      action: "accept",
      lastSeq: 1,
      gap: { expected: 2, got: 3 },
    });

    store.forget("run-1");
    expect(store.accept("run-1", 1)).toMatchObject({
      action: "accept",
      lastSeq: 0,
    });
  });

  it("rolls back only the seq that is still current", () => {
    const store = new UpstreamSeqStore();
    const first = store.accept("run-1", 1);
    if (first.action !== "accept") throw new Error("expected accept");
    store.rollback("run-1", 1, first.lastSeq);

    expect(store.accept("run-1", 1).action).toBe("accept");
    store.accept("run-1", 2);
    store.rollback("run-1", 1, 0);
    expect(store.accept("run-1", 2).action).toBe("drop");
  });
});
