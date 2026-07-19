import { describe, it, expect } from "vitest";
import { EventType } from "@ag-ui/client";
import { AcpToAguiMapper, type AcpAguiEvent } from "./to-agui";
import type { AcpSessionUpdate } from "../engine/client";

function makeMapper() {
  const events: AcpAguiEvent[] = [];
  const traces: string[] = [];
  const mapper = new AcpToAguiMapper({
    threadId: "thread-1",
    runId: "run-1",
    emit: (e) => events.push(e),
    trace: (name) => traces.push(name),
  });
  return { mapper, events, traces };
}

const textChunk = (text: string, messageId?: string): AcpSessionUpdate =>
  ({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text },
    ...(messageId ? { messageId } : {}),
  }) as AcpSessionUpdate;

const thoughtChunk = (text: string): AcpSessionUpdate =>
  ({
    sessionUpdate: "agent_thought_chunk",
    content: { type: "text", text },
  }) as AcpSessionUpdate;

const byType = (events: AcpAguiEvent[], type: EventType) =>
  events.filter((e) => e.type === type);

describe("AcpToAguiMapper", () => {
  it("emits one START/END for multiple chunks of the same message", () => {
    const { mapper, events } = makeMapper();
    mapper.handle(textChunk("Hello ", "m1"));
    mapper.handle(textChunk("world", "m1"));
    mapper.finalize();

    expect(byType(events, EventType.TEXT_MESSAGE_START)).toHaveLength(1);
    expect(byType(events, EventType.TEXT_MESSAGE_END)).toHaveLength(1);
    const deltas = byType(events, EventType.TEXT_MESSAGE_CONTENT).map(
      (e) => (e as { delta: string }).delta
    );
    expect(deltas).toEqual(["Hello ", "world"]);
  });

  it("starts a new message when the ACP messageId changes", () => {
    const { mapper, events } = makeMapper();
    mapper.handle(textChunk("first", "m1"));
    mapper.handle(textChunk("second", "m2"));
    mapper.finalize();
    expect(byType(events, EventType.TEXT_MESSAGE_START)).toHaveLength(2);
    expect(byType(events, EventType.TEXT_MESSAGE_END)).toHaveLength(2);
  });

  it("separates reasoning from final text", () => {
    const { mapper, events } = makeMapper();
    mapper.handle(thoughtChunk("thinking"));
    mapper.handle(textChunk("answer"));
    mapper.finalize();

    const order = events.map((e) => e.type);
    expect(order).toContain(EventType.REASONING_MESSAGE_END);
    expect(order).toContain(EventType.TEXT_MESSAGE_START);
    // reasoning closed before text opened
    expect(order.indexOf(EventType.REASONING_END)).toBeLessThan(
      order.indexOf(EventType.TEXT_MESSAGE_START)
    );
  });

  it("maps a normal tool call lifecycle", () => {
    const { mapper, events } = makeMapper();
    mapper.handle({
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      title: "Read file",
      kind: "read",
      rawInput: { path: "a.ts" },
    } as AcpSessionUpdate);
    mapper.handle({
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      status: "completed",
      rawOutput: { text: "file body" },
    } as AcpSessionUpdate);

    expect(byType(events, EventType.TOOL_CALL_START)).toHaveLength(1);
    expect(byType(events, EventType.TOOL_CALL_ARGS)).toHaveLength(1);
    expect(byType(events, EventType.TOOL_CALL_RESULT)).toHaveLength(1);
    expect(byType(events, EventType.TOOL_CALL_END)).toHaveLength(1);

    const start = byType(events, EventType.TOOL_CALL_START)[0] as {
      toolCallName: string;
      toolCallId: string;
    };
    expect(start.toolCallName).toBe("read");
    expect(start.toolCallId).toBe("run-1-t1");
    const args = byType(events, EventType.TOOL_CALL_ARGS)[0] as { delta: string };
    expect(args.delta).toContain("a.ts");
    const result = byType(events, EventType.TOOL_CALL_RESULT)[0] as {
      content: string;
    };
    expect(result.content).toContain("file body");
  });

  it("preserves a pending tool title when in_progress only adds raw input", () => {
    const { mapper, events } = makeMapper();
    mapper.handle({
      sessionUpdate: "tool_call",
      toolCallId: "bash-1",
      title: "bash",
      kind: "other",
      status: "pending",
      rawInput: {},
    } as AcpSessionUpdate);
    mapper.handle({
      sessionUpdate: "tool_call_update",
      toolCallId: "bash-1",
      kind: "other",
      status: "in_progress",
      rawInput: { command: "sysctl -n hw.ncpu" },
    } as AcpSessionUpdate);

    const args = byType(events, EventType.TOOL_CALL_ARGS)[0] as { delta: string };
    expect(JSON.parse(args.delta)).toMatchObject({
      title: "bash",
      command: "sysctl -n hw.ncpu",
    });
  });

  it("splits text around tools when ACP reuses the same messageId", () => {
    const { mapper, events } = makeMapper();
    mapper.handle(textChunk("收集信息：", "m1"));
    mapper.handle({
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      title: "读取系统信息",
      kind: "read",
      status: "in_progress",
      rawInput: { command: "sw_vers" },
    } as AcpSessionUpdate);
    mapper.handle({
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      status: "completed",
      rawOutput: { text: "macOS" },
    } as AcpSessionUpdate);
    // pi continues to use m1 for the final answer after the tool call.
    mapper.handle(textChunk("## 系统分析报告", "m1"));
    mapper.finalize();

    const starts = byType(events, EventType.TEXT_MESSAGE_START) as Array<{
      messageId: string;
    }>;
    const contents = byType(events, EventType.TEXT_MESSAGE_CONTENT) as Array<{
      messageId: string;
      delta: string;
    }>;
    const toolStart = byType(events, EventType.TOOL_CALL_START)[0] as {
      parentMessageId?: string;
    };

    expect(starts).toHaveLength(2);
    expect(starts[0].messageId).toBe("run-1-m1");
    expect(starts[1].messageId).toBe("run-1-m1-part-2");
    expect(contents.map((event) => event.delta)).toEqual([
      "收集信息：",
      "## 系统分析报告",
    ]);
    expect(toolStart.parentMessageId).toBe(starts[0].messageId);
  });

  // 回归:opencode 的真实序列是 tool_call(pending) → session/request_permission
  // → tool_call_update(in_progress)。pending 阶段若开了 TOOL_CALL_START,权限
  // 中断要发的 RUN_FINISHED 会被 AG-UI 拒绝:
  //   Cannot send 'RUN_FINISHED' while tool calls are still active
  it("does not open a tool call while it is pending approval", () => {
    const { mapper, events } = makeMapper();
    mapper.handle({
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      title: "glob",
      kind: "search",
      status: "pending",
      rawInput: {},
    } as AcpSessionUpdate);

    // 权限中断就发生在这一刻:此时不能有任何活跃 tool call。
    expect(byType(events, EventType.TOOL_CALL_START)).toHaveLength(0);
    expect(byType(events, EventType.TOOL_CALL_ARGS)).toHaveLength(0);
    mapper.closeMessages();
    expect(byType(events, EventType.TOOL_CALL_START)).toHaveLength(0);

    // 批准后 opencode 推进到 in_progress,这时才开,参数随之补上。
    mapper.handle({
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      status: "in_progress",
      kind: "search",
      rawInput: { pattern: ".agework/.env*" },
    } as AcpSessionUpdate);
    expect(byType(events, EventType.TOOL_CALL_START)).toHaveLength(0);
    mapper.setRunId("run-2");
    mapper.resume();
    expect(byType(events, EventType.TOOL_CALL_START)).toHaveLength(1);
    const args = byType(events, EventType.TOOL_CALL_ARGS)[0] as { delta: string };
    expect(args.delta).toContain(".agework/.env*");

    mapper.handle({
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      status: "completed",
      rawOutput: { text: "found" },
    } as AcpSessionUpdate);
    expect(byType(events, EventType.TOOL_CALL_RESULT)).toHaveLength(1);
    expect(byType(events, EventType.TOOL_CALL_END)).toHaveLength(1);
  });

  it("keeps a pending-only tool call out of the stream at finalize", () => {
    const { mapper, events } = makeMapper();
    mapper.handle({
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      title: "glob",
      kind: "search",
      status: "pending",
    } as AcpSessionUpdate);
    mapper.finalize();

    // 从未开始就不该补一个孤立的 END（拒绝审批后就是这条路径）。
    expect(byType(events, EventType.TOOL_CALL_START)).toHaveLength(0);
    expect(byType(events, EventType.TOOL_CALL_END)).toHaveLength(0);
  });

  it("keeps an active tool id stable when an approval resumes on a new run", () => {
    const { mapper, events } = makeMapper();
    mapper.handle({
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      title: "Read file",
      kind: "read",
      status: "in_progress",
      rawInput: { filePath: ".env" },
    } as AcpSessionUpdate);
    mapper.closeMessages();

    mapper.setRunId("run-2");
    mapper.resume();
    mapper.handle({
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      status: "completed",
      rawOutput: { error: "File not found" },
    } as AcpSessionUpdate);

    const starts = byType(events, EventType.TOOL_CALL_START) as Array<{
      toolCallId: string;
    }>;
    const results = byType(events, EventType.TOOL_CALL_RESULT) as Array<{
      toolCallId: string;
    }>;
    const ends = byType(events, EventType.TOOL_CALL_END) as Array<{
      toolCallId: string;
    }>;
    expect(starts[0].toolCallId).toBe("run-1-t1");
    expect(results[0].toolCallId).toBe("run-1-t1");
    expect(ends[0].toolCallId).toBe("run-1-t1");
  });

  it("closes an active tool before an interrupt and only adds its result on resume", () => {
    const { mapper, events } = makeMapper();
    mapper.handle({
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      status: "in_progress",
      kind: "read",
      rawInput: { filePath: ".env" },
    } as AcpSessionUpdate);
    mapper.closeMessages();

    expect(byType(events, EventType.TOOL_CALL_END)).toHaveLength(1);
    mapper.handle({
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      status: "completed",
      rawOutput: { text: "ok" },
    } as AcpSessionUpdate);
    // Completion can race in before the resume command; it must be held back.
    expect(byType(events, EventType.TOOL_CALL_RESULT)).toHaveLength(0);

    mapper.setRunId("run-2");
    mapper.resume();
    expect(byType(events, EventType.TOOL_CALL_RESULT)).toHaveLength(1);
    expect(byType(events, EventType.TOOL_CALL_END)).toHaveLength(1);
  });

  it("defers a tool update racing after the interrupt until resume", () => {
    const { mapper, events } = makeMapper();
    mapper.closeMessages();
    mapper.handle({
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      status: "in_progress",
      kind: "search",
      rawInput: { pattern: "**/.env" },
    } as AcpSessionUpdate);

    expect(byType(events, EventType.TOOL_CALL_START)).toHaveLength(0);
    mapper.setRunId("run-2");
    mapper.resume();

    const starts = byType(events, EventType.TOOL_CALL_START) as Array<{
      toolCallId: string;
    }>;
    expect(starts).toHaveLength(1);
    expect(starts[0].toolCallId).toBe("run-2-t1");

    mapper.handle({
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      status: "completed",
      rawOutput: { output: "done" },
    } as AcpSessionUpdate);
    expect(byType(events, EventType.TOOL_CALL_END)).toHaveLength(1);
    expect(
      (byType(events, EventType.TOOL_CALL_END)[0] as { toolCallId: string }).toolCallId
    ).toBe("run-2-t1");
  });

  it("handles a tool_call_update that arrives before the tool_call", () => {
    const { mapper, events } = makeMapper();
    mapper.handle({
      sessionUpdate: "tool_call_update",
      toolCallId: "t9",
      status: "in_progress",
      kind: "execute",
    } as AcpSessionUpdate);
    // START emitted from the update (placeholder), no premature END
    expect(byType(events, EventType.TOOL_CALL_START)).toHaveLength(1);
    expect(byType(events, EventType.TOOL_CALL_END)).toHaveLength(0);

    mapper.handle({
      sessionUpdate: "tool_call",
      toolCallId: "t9",
      title: "Run",
      kind: "execute",
      rawInput: { cmd: "ls" },
    } as AcpSessionUpdate);
    // still only one START
    expect(byType(events, EventType.TOOL_CALL_START)).toHaveLength(1);
  });

  it("emits a result and end for a failed tool", () => {
    const { mapper, events } = makeMapper();
    mapper.handle({
      sessionUpdate: "tool_call",
      toolCallId: "t2",
      title: "Edit",
      kind: "edit",
    } as AcpSessionUpdate);
    mapper.handle({
      sessionUpdate: "tool_call_update",
      toolCallId: "t2",
      status: "failed",
      rawOutput: { error: "boom" },
    } as AcpSessionUpdate);

    expect(byType(events, EventType.TOOL_CALL_RESULT)).toHaveLength(1);
    expect(byType(events, EventType.TOOL_CALL_END)).toHaveLength(1);
    const result = byType(events, EventType.TOOL_CALL_RESULT)[0] as {
      content: string;
    };
    expect(result.content).toContain("boom");
  });

  it("closes an incomplete tool at finalize", () => {
    const { mapper, events } = makeMapper();
    mapper.handle({
      sessionUpdate: "tool_call",
      toolCallId: "t3",
      title: "Search",
      kind: "search",
    } as AcpSessionUpdate);
    expect(byType(events, EventType.TOOL_CALL_END)).toHaveLength(0);
    mapper.finalize();
    expect(byType(events, EventType.TOOL_CALL_END)).toHaveLength(1);
  });

  it("maps plan to a custom event", () => {
    const { mapper, events } = makeMapper();
    mapper.handle({
      sessionUpdate: "plan",
      entries: [{ content: "step 1", priority: "medium", status: "pending" }],
    } as AcpSessionUpdate);
    const custom = byType(events, EventType.CUSTOM)[0] as {
      name: string;
      value: { entries: unknown[] };
    };
    expect(custom.name).toBe("acp.plan");
    expect(custom.value.entries).toHaveLength(1);
  });

  it("captures usage_update as context usage without emitting", () => {
    const { mapper, events } = makeMapper();
    mapper.handle({
      sessionUpdate: "usage_update",
      used: 1200,
      size: 200000,
    } as AcpSessionUpdate);
    expect(events).toHaveLength(0);
    expect(mapper.getContextUsage()).toEqual({ used: 1200, size: 200000, cost: undefined });
  });

  it("traces unknown updates without crashing", () => {
    const { mapper, events, traces } = makeMapper();
    mapper.handle({ sessionUpdate: "some_future_thing" } as unknown as AcpSessionUpdate);
    expect(events).toHaveLength(0);
    expect(traces).toContain("sdk.acp.unknown_update");
  });

  it("accumulates assistant + tool messages for a snapshot", () => {
    const { mapper } = makeMapper();
    mapper.handle(textChunk("done"));
    mapper.handle({
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      title: "Read",
      kind: "read",
    } as AcpSessionUpdate);
    mapper.handle({
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      status: "completed",
      rawOutput: "out",
    } as AcpSessionUpdate);
    mapper.finalize();
    const msgs = mapper.getMessages();
    expect(msgs.some((m) => m.role === "assistant" && m.content === "done")).toBe(true);
    expect(msgs.some((m) => m.role === "tool")).toBe(true);
  });
});
