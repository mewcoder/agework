import { describe, it, expect, vi, afterEach } from "vitest";
import type { ChatModelRunResult } from "@assistant-ui/react";
import { parseSseSnapshots, createThreadHistoryAdapter } from "./thread-history-adapter";
import { conversationsApi } from "@/api/conversations";

type Snapshot = { content: unknown[]; status: { type: string; reason?: string; error?: string } };

function toStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

describe("parseSseSnapshots", () => {
  it("解析多条 SSE 快照", async () => {
    const body = toStream([
      'data: {"content":[{"type":"text","text":"hi"}],"status":{"type":"running"}}\n\n',
      'data: {"content":[{"type":"text","text":"hello world"}],"status":{"type":"complete","reason":"stop"}}\n\n',
    ]);

    const results: unknown[] = [];
    for await (const r of parseSseSnapshots(body)) results.push(r);

    expect(results).toHaveLength(2);
    expect((results[0] as { content: { text: string }[] }).content[0].text).toBe("hi");
    expect((results[1] as { status: { type: string } }).status.type).toBe("complete");
  });

  it("跨 chunk 的事件边界能正确拼接", async () => {
    const body = toStream([
      'data: {"content":[{"type":"text","text":"par',
      'tial"}]}\n\ndata: {"content":[{"type":"text","text":"second"}]}\n\n',
    ]);

    const results: unknown[] = [];
    for await (const r of parseSseSnapshots(body)) results.push(r);

    expect(results).toHaveLength(2);
    expect((results[0] as { content: { text: string }[] }).content[0].text).toBe("partial");
  });

  it("跳过无法解析的帧", async () => {
    const body = toStream([
      "data: not-json\n\n",
      'data: {"content":[],"status":{"type":"running"}}\n\n',
    ]);

    const results: unknown[] = [];
    for await (const r of parseSseSnapshots(body)) results.push(r);

    expect(results).toHaveLength(1);
  });

  it("空流不产生结果", async () => {
    const body = toStream([]);
    const results: unknown[] = [];
    for await (const r of parseSseSnapshots(body)) results.push(r);
    expect(results).toHaveLength(0);
  });
});

describe("resume 结束时刷新 conversation.runStatus", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function makeAdapter(qc: any, remoteId: string, snapshots: Snapshot[]) {
    const aui = {
      threadListItem: () => ({
        getState: () => ({ remoteId }),
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    // 用 fetch 全局 stub 返回固定 snapshots
    const originalFetch = globalThis.fetch;
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const snap of snapshots) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(snap)}\n\n`));
        }
        controller.close();
      },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, body }) as any;
    const adapter = createThreadHistoryAdapter(aui, qc);
    // 还原 stub 的工具
    const restore = () => { globalThis.fetch = originalFetch; };
    return { adapter, restore };
  }

  it("终态 complete 时把 runStatus 乐观更新为 idle 并 invalidate", async () => {
    const setQueryData = vi.fn();
    const getQueriesData = vi.fn().mockReturnValue([
      [{ queryKey: ["conversations"] }, {
        conversations: [{ conversationId: "c1", runStatus: "running" }],
      }],
    ]);
    const invalidateQueries = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const qc = { getQueriesData, setQueryData, invalidateQueries } as any;
    const { adapter, restore } = makeAdapter(qc, "c1", [
      { content: [], status: { type: "incomplete", reason: "streaming" } },
      { content: [{ type: "text", text: "done" }], status: { type: "complete", reason: "stop" } },
    ]);

    const ac = new AbortController();
    const results: ChatModelRunResult[] = [];
    for await (const r of adapter.resume!({ abortSignal: ac.signal } as never)) {
      results.push(r as ChatModelRunResult);
    }

    restore();

    // 中间快照被归一化成 running
    expect(results[0].status).toEqual({ type: "running" });
    // 终态快照保持 complete
    expect(results[1].status).toEqual({ type: "complete", reason: "stop" });

    // 乐观更新：把 c1 的 runStatus 置为 idle
    expect(setQueryData).toHaveBeenCalledTimes(1);
    const [, nextData] = setQueryData.mock.calls[0];
    expect(nextData.conversations[0].runStatus).toBe("idle");
    // invalidate 拉权威值兜底
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["conversations"] });
  });

  it("终态 error 时把 runStatus 乐观更新为 error", async () => {
    const setQueryData = vi.fn();
    const getQueriesData = vi.fn().mockReturnValue([
      [{ queryKey: ["conversations"] }, {
        conversations: [{ conversationId: "c1", runStatus: "running" }],
      }],
    ]);
    const invalidateQueries = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const qc = { getQueriesData, setQueryData, invalidateQueries } as any;
    const { adapter, restore } = makeAdapter(qc, "c1", [
      { content: [], status: { type: "incomplete", reason: "error", error: "boom" } },
    ]);

    const ac = new AbortController();
    for await (const _iter of adapter.resume!({ abortSignal: ac.signal } as never)) {
      // drain
      void _iter;
    }

    restore();

    const [, nextData] = setQueryData.mock.calls[0];
    expect(nextData.conversations[0].runStatus).toBe("error");
  });

  it("abort 时不触发乐观更新 / invalidate", async () => {
    const setQueryData = vi.fn();
    const invalidateQueries = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const qc = { getQueryData: vi.fn(), setQueryData, invalidateQueries } as any;
    const { adapter, restore } = makeAdapter(qc, "c1", [
      { content: [], status: { type: "incomplete", reason: "streaming" } },
    ]);

    const ac = new AbortController();
    ac.abort();
    for await (const _iter of adapter.resume!({ abortSignal: ac.signal } as never)) {
      // drain（实际上由于 abort 会立即 return）
      void _iter;
    }

    restore();

    expect(setQueryData).not.toHaveBeenCalled();
    expect(invalidateQueries).not.toHaveBeenCalled();
  });
});

// ── load() requires_action（pendingUserAction=question）场景 ─────────────────

describe("load() requires_action 场景", () => {
  function makeLoadAdapter(opts: {
    remoteId: string;
    runStatus: string;
    pendingUserAction?: string | null;
    messages: unknown[];
  }) {
    const { remoteId, runStatus, pendingUserAction, messages } = opts;
    const aui = {
      threadListItem: () => ({
        getState: () => ({
          remoteId,
          custom: { runStatus, pendingUserAction: pendingUserAction ?? null },
        }),
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    // mock conversationsApi.listMessages
    const listMessagesSpy = vi
      .spyOn(conversationsApi, "listMessages")
      .mockResolvedValue(messages as never);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const qc = {} as any;
    const adapter = createThreadHistoryAdapter(aui, qc);
    return { adapter, listMessagesSpy };
  }

  function assistantMsg(id: string, statusType: string) {
    return {
      id,
      parent_id: null,
      content: {
        id,
        role: "assistant",
        content: [{ type: "text", text: "thinking..." }],
        status: { type: statusType },
      },
    };
  }

  function userMsg(id: string) {
    return {
      id,
      parent_id: null,
      content: { id, role: "user", content: "hello" },
    };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("pendingUserAction=question 时不触发 resume，不过滤进行中消息，status 归一化成 running", async () => {
    const { adapter } = makeLoadAdapter({
      remoteId: "c1",
      runStatus: "running",
      pendingUserAction: "question",
      messages: [
        userMsg("u1"),
        // 进行中的 assistant 消息（status=requires-action），不应被过滤
        assistantMsg("a1", "requires-action"),
      ],
    });

    const result = await adapter.load!();

    // 不触发 resume
    expect(result.unstable_resume).toBeUndefined();
    // 消息未被过滤
    expect(result.messages).toHaveLength(2);
    // 进行中 assistant 消息的 status 被归一化成 running
    const assistantMsgResult = result.messages[1] as unknown as {
      message: { status: { type: string } };
    };
    expect(assistantMsgResult.message.status.type).toBe("running");
  });

  it("正常 running（无 pendingUserAction）时触发 resume，过滤进行中消息", async () => {
    const { adapter } = makeLoadAdapter({
      remoteId: "c1",
      runStatus: "running",
      pendingUserAction: null,
      messages: [
        userMsg("u1"),
        assistantMsg("a1", "running"), // 进行中的，应被过滤
      ],
    });

    const result = await adapter.load!();

    // 触发 resume
    expect(result.unstable_resume).toBe(true);
    // 进行中消息被过滤
    expect(result.messages).toHaveLength(1);
    expect(
      (result.messages[0] as unknown as { message: { role: string } }).message
        .role,
    ).toBe("user");
  });

  it("idle 时不过滤、不 resume", async () => {
    const { adapter } = makeLoadAdapter({
      remoteId: "c1",
      runStatus: "idle",
      pendingUserAction: null,
      messages: [
        userMsg("u1"),
        assistantMsg("a1", "complete"), // 已完成，保留
      ],
    });

    const result = await adapter.load!();

    expect(result.unstable_resume).toBeUndefined();
    expect(result.messages).toHaveLength(2);
  });
});

