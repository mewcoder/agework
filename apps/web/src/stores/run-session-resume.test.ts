import { describe, it, expect, vi, afterEach } from "vitest";
import type { ChatModelRunResult } from "@assistant-ui/react";
import { openResumeStream, parseSseSnapshots } from "./run-session-resume";

type Snapshot = {
  content: unknown[];
  status: { type: string; reason?: string; error?: string };
};

function toStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

function snapshotBody(snapshots: Snapshot[]): ReadableStream<Uint8Array> {
  return toStream(
    snapshots.map((snap) => `data: ${JSON.stringify(snap)}\n\n`),
  );
}

function makeQc() {
  const setQueryData = vi.fn();
  const getQueriesData = vi.fn().mockReturnValue([
    [
      { queryKey: ["conversations"] },
      { conversations: [{ conversationId: "c1", runStatus: "running" }] },
    ],
  ]);
  const invalidateQueries = vi.fn();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const qc = { getQueriesData, setQueryData, invalidateQueries } as any;
  return { qc, setQueryData, getQueriesData, invalidateQueries };
}

async function collect(
  stream: AsyncGenerator<ChatModelRunResult, void, unknown>,
): Promise<ChatModelRunResult[]> {
  const results: ChatModelRunResult[] = [];
  for await (const r of stream) results.push(r);
  return results;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

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
  it("终态 complete 时把 runStatus 乐观更新为 idle 并 invalidate,中间快照归一化成 running", async () => {
    const { qc, setQueryData, invalidateQueries } = makeQc();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      body: snapshotBody([
        { content: [], status: { type: "incomplete", reason: "streaming" } },
        {
          content: [{ type: "text", text: "done" }],
          status: { type: "complete", reason: "stop" },
        },
      ]),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any));

    const ac = new AbortController();
    const results = await collect(
      openResumeStream("c1", qc, { signal: ac.signal }),
    );

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
    const { qc, setQueryData } = makeQc();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      body: snapshotBody([
        { content: [], status: { type: "incomplete", reason: "error", error: "boom" } },
      ]),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any));

    await collect(openResumeStream("c1", qc));

    const [, nextData] = setQueryData.mock.calls[0];
    expect(nextData.conversations[0].runStatus).toBe("error");
  });

  it("abort 时不触发乐观更新 / invalidate", async () => {
    const { qc, setQueryData, invalidateQueries } = makeQc();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      body: snapshotBody([
        { content: [], status: { type: "incomplete", reason: "streaming" } },
      ]),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any));

    const ac = new AbortController();
    ac.abort();
    await collect(openResumeStream("c1", qc, { signal: ac.signal }));

    expect(setQueryData).not.toHaveBeenCalled();
    expect(invalidateQueries).not.toHaveBeenCalled();
  });
});

describe("409 / 404 处理", () => {
  it("409(requires_action)直接结束且不回填", async () => {
    const { qc, setQueryData, invalidateQueries } = makeQc();
    const fetchMock = vi
      .fn()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockResolvedValue({ ok: false, status: 409, body: null } as any);
    vi.stubGlobal("fetch", fetchMock);

    const results = await collect(openResumeStream("c1", qc));

    expect(results).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(setQueryData).not.toHaveBeenCalled();
    expect(invalidateQueries).not.toHaveBeenCalled();
  });

  it("404(无活跃 run)直接结束且不回填", async () => {
    const { qc, invalidateQueries } = makeQc();
    vi.stubGlobal("fetch", vi
      .fn()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockResolvedValue({ ok: false, status: 404, body: null } as any));

    const results = await collect(openResumeStream("c1", qc));

    expect(results).toHaveLength(0);
    expect(invalidateQueries).not.toHaveBeenCalled();
  });

});
