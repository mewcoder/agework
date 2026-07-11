import { describe, it, expect, vi, afterEach } from "vitest";
import { setConversationRunStatusOptimistic } from "./conversations-cache";

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
