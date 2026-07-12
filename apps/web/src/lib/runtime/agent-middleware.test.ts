import { describe, it, expect, vi, beforeEach } from "vitest";
import { of, type Observable } from "rxjs";
import { EventType } from "@ag-ui/client";
import type { AbstractAgent, BaseEvent, RunAgentInput } from "@ag-ui/client";
import { useSelectionStore } from "@/stores/selection-store";
import { createAgentMiddleware } from "./agent-middleware";

vi.mock("@/lib/runtime/thread-list-adapter", () => ({
  setPendingInitializeTitle: vi.fn(),
  clearPendingInitializeTitle: vi.fn(),
}));

/**
 * 编排回归测试:断言 middleware「什么事件触发哪次会话运行态写入」。
 * 规则本身在 run-session-status-rules.test.ts 用表锁死,这里锁的是
 * 编排层确实在用规则(历史 bug:RUN_FINISHED{interrupt} 被 inline 写成 idle)。
 */

const BASE_CONVERSATION = {
  conversationId: "c1",
  runStatus: "running",
  pendingUserAction: "question",
};

function makeQc() {
  const setQueryData = vi.fn();
  const getQueriesData = vi.fn((filters: { queryKey: unknown[] }) =>
    filters.queryKey[0] === "conversations"
      ? [[["conversations"], { conversations: [{ ...BASE_CONVERSATION }] }]]
      : [],
  );
  const invalidateQueries = vi.fn();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const qc = { getQueriesData, setQueryData, invalidateQueries } as any;
  return { qc, setQueryData, invalidateQueries };
}

async function runMiddleware(events: BaseEvent[]) {
  const { qc, setQueryData, invalidateQueries } = makeQc();
  const aui = {
    threadListItem: () => ({
      getState: () => ({ remoteId: "c1", custom: { agentType: "claude" } }),
      initialize: vi.fn(),
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  const next = { run: () => of(...events) } as unknown as AbstractAgent;
  const params = {
    threadId: "t1",
    runId: "r1",
    messages: [{ id: "m1", role: "user", content: "hi" }],
    tools: [],
    context: [],
    state: {},
    forwardedProps: {},
  } as unknown as RunAgentInput;

  const middleware = createAgentMiddleware(aui, qc);
  const out = middleware(params, next) as unknown as Observable<BaseEvent>;
  await new Promise<void>((resolve, reject) => {
    out.subscribe({ next: () => {}, error: reject, complete: resolve });
  });
  return { setQueryData, invalidateQueries };
}

/** 第 n 次 setQueryData 写入后 c1 的字段。 */
function writtenConversation(setQueryData: ReturnType<typeof vi.fn>, call: number) {
  const [, data] = setQueryData.mock.calls[call]!;
  return (data as { conversations: (typeof BASE_CONVERSATION)[] }).conversations[0]!;
}

beforeEach(() => {
  useSelectionStore.setState({ selectedWorkspaceId: "w1" });
});

describe("createAgentMiddleware 会话运行态编排", () => {
  it("run 启动写 running 并清掉待答标记", async () => {
    const { setQueryData } = await runMiddleware([
      { type: EventType.RUN_STARTED } as BaseEvent,
      { type: EventType.RUN_FINISHED } as BaseEvent,
    ]);
    const started = writtenConversation(setQueryData, 0);
    expect(started.runStatus).toBe("running");
    expect(started.pendingUserAction).toBeNull();
  });

  it("RUN_FINISHED{interrupt} 不得写 idle,只标记待答", async () => {
    const { setQueryData } = await runMiddleware([
      { type: EventType.RUN_STARTED } as BaseEvent,
      {
        type: EventType.RUN_FINISHED,
        outcome: { type: "interrupt", interrupts: [{ id: "q1", reason: "input_required" }] },
      } as unknown as BaseEvent,
    ]);
    // 任何一次写入都不允许出现 idle(挂起时后端真相是 running+question)
    for (let i = 0; i < setQueryData.mock.calls.length; i++) {
      expect(writtenConversation(setQueryData, i).runStatus).not.toBe("idle");
    }
    const finished = writtenConversation(setQueryData, setQueryData.mock.calls.length - 1);
    expect(finished.pendingUserAction).toBe("question");
    expect(finished.runStatus).toBe("running");
  });

  it("RUN_FINISHED{success} 写 idle", async () => {
    const { setQueryData } = await runMiddleware([
      { type: EventType.RUN_STARTED } as BaseEvent,
      { type: EventType.RUN_FINISHED, outcome: { type: "success" } } as unknown as BaseEvent,
    ]);
    const finished = writtenConversation(setQueryData, setQueryData.mock.calls.length - 1);
    expect(finished.runStatus).toBe("idle");
  });

  it("RUN_ERROR 写 error", async () => {
    const { setQueryData } = await runMiddleware([
      { type: EventType.RUN_STARTED } as BaseEvent,
      { type: EventType.RUN_ERROR, message: "boom" } as unknown as BaseEvent,
    ]);
    const finished = writtenConversation(setQueryData, setQueryData.mock.calls.length - 1);
    expect(finished.runStatus).toBe("error");
  });

  it("流 complete 时 invalidate 一次校准权威值", async () => {
    const { invalidateQueries } = await runMiddleware([
      { type: EventType.RUN_STARTED } as BaseEvent,
      { type: EventType.RUN_FINISHED } as BaseEvent,
    ]);
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["conversations"] });
  });
});
