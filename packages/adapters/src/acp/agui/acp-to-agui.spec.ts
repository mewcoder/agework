import { describe, it, expect } from "vitest";
import { EventType } from "@ag-ui/client";
import { AcpToAguiMapper, type AcpAguiEvent } from "./acp-to-agui";
import type { AcpSessionUpdate } from "../client/acp-client";

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
