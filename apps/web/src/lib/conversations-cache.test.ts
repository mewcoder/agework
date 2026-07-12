import { describe, it, expect, vi, afterEach } from "vitest";
import {
  conversationKeys,
  setConversationRunStatus,
  setConversationRunStatusOptimistic,
} from "./conversations-cache";

function makeQc() {
  const setQueryData = vi.fn();
  const getQueriesData = vi.fn().mockReturnValue([
    [
      ["conversations"],
      { conversations: [{ conversationId: "c1", runStatus: "running" }] },
    ],
  ]);
  const invalidateQueries = vi.fn();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const qc = { getQueriesData, setQueryData, invalidateQueries } as any;
  return { qc, setQueryData, invalidateQueries };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("conversationKeys", () => {
  it("list / search 变体都在 all 前缀下(invalidate(all) 必能命中)", () => {
    expect(conversationKeys.list("regular", "updatedAt").slice(0, 1)).toEqual([
      ...conversationKeys.all,
    ]);
    expect(conversationKeys.search("q", 20).slice(0, 1)).toEqual([
      ...conversationKeys.all,
    ]);
  });

  it("archived 列表变体由 factory 判定(位置语义不外泄)", () => {
    expect(
      conversationKeys.isArchivedList(conversationKeys.list("archived", "updatedAt")),
    ).toBe(true);
    expect(
      conversationKeys.isArchivedList(conversationKeys.list("regular", "updatedAt")),
    ).toBe(false);
    expect(conversationKeys.isArchivedList(conversationKeys.list(undefined))).toBe(
      false,
    );
  });

  it("运行状态写入跳过 archived 列表变体", () => {
    const setQueryData = vi.fn();
    const getQueriesData = vi.fn().mockReturnValue([
      [
        conversationKeys.list("archived", "updatedAt"),
        { conversations: [{ conversationId: "c1", runStatus: "running" }] },
      ],
      [
        conversationKeys.list("regular", "updatedAt"),
        { conversations: [{ conversationId: "c1", runStatus: "running" }] },
      ],
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const qc = { getQueriesData, setQueryData } as any;

    setConversationRunStatus(qc, "c1", "idle");

    expect(setQueryData).toHaveBeenCalledTimes(1);
    expect(setQueryData.mock.calls[0]![0]).toEqual(
      conversationKeys.list("regular", "updatedAt"),
    );
  });
});

describe("setConversationRunStatusOptimistic", () => {
  it("立即乐观写入,不立即 invalidate(避免 refetch 拉回旧值冲掉乐观状态)", () => {
    vi.useFakeTimers();
    const { qc, setQueryData, invalidateQueries } = makeQc();

    setConversationRunStatusOptimistic(qc, "c1", "idle", {
      revalidateAfterMs: 1500,
    });

    expect(setQueryData).toHaveBeenCalledTimes(1);
    const [, nextData] = setQueryData.mock.calls[0];
    expect(nextData.conversations[0].runStatus).toBe("idle");
    expect(invalidateQueries).not.toHaveBeenCalled();
  });

  it("到达 revalidateAfterMs 后 invalidate 一次校准权威值", () => {
    vi.useFakeTimers();
    const { qc, invalidateQueries } = makeQc();

    setConversationRunStatusOptimistic(qc, "c1", "idle", {
      revalidateAfterMs: 1500,
    });
    vi.advanceTimersByTime(1500);

    expect(invalidateQueries).toHaveBeenCalledTimes(1);
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["conversations"],
    });
  });
});
