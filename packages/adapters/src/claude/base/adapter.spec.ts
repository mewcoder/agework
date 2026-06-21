import { ClaudeAgentAdapter } from "./adapter";
import { EventType } from "@ag-ui/client";
import type { BaseEvent } from "@ag-ui/core";
import { lastValueFrom } from "rxjs";

/**
 * Helper: build a mock SDK stream_event message.
 * These mimic the structure of SDKPartialAssistantMessage events
 * that the Claude Agent SDK emits during streaming.
 */
function streamEvent(event: Record<string, unknown>) {
  return { type: "stream_event", event };
}

function messageStart(messageId?: string) {
  return streamEvent({
    type: "message_start",
    message: { id: messageId ?? "msg-1", role: "assistant", content: [] },
  });
}

function contentBlockStart(block: Record<string, unknown>) {
  return streamEvent({ type: "content_block_start", content_block: block, index: 0 });
}

function contentBlockDelta(delta: Record<string, unknown>) {
  return streamEvent({ type: "content_block_delta", delta, index: 0 });
}

function contentBlockStop(index = 0) {
  return streamEvent({ type: "content_block_stop", index });
}

function messageStop() {
  return streamEvent({ type: "message_stop" });
}

function toolUseStart(id: string, name: string) {
  return contentBlockStart({ type: "tool_use", id, name, input: {} });
}

function inputJsonDelta(json: string) {
  return contentBlockDelta({ type: "input_json_delta", partial_json: json });
}

function textDelta(text: string) {
  return contentBlockDelta({ type: "text_delta", text });
}

/**
 * Helper: create an async iterable from an array of messages.
 * This simulates the messageStream that ClaudeAgentAdapter.translateStream consumes.
 */
async function* asyncIterableFrom<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) {
    yield item;
  }
}

async function* throwingAsyncIterable(error: Error): AsyncGenerator<unknown> {
  throw error;
}

/**
 * Helper: collect all events from an adapter.run() observable.
 */
async function collectEvents(
  adapter: ClaudeAgentAdapter,
  input: Record<string, unknown>,
  mockStream: AsyncIterable<unknown>,
): Promise<BaseEvent[]> {
  // Override the internal query/translateStream to use our mock stream
  // We'll call translateStream directly through the internals pattern
  const events: BaseEvent[] = [];

  // Use the adapter's run method but intercept the query stream
  // Since run() calls query() internally, we need to mock at a higher level.
  // Instead, we directly test streamMessages by accessing internals.
  const internals = adapter as unknown as {
    sessions: Map<string, { sessionId: string; active: boolean; lastUsed: number }>;
    translateStream(
      input: any,
      messageStream: AsyncIterable<unknown>,
      subscriber: any,
    ): Promise<void>;
  };

  // Create a minimal input
  const runInput = {
    threadId: "test-thread",
    runId: "test-run",
    messages: [],
    ...input,
  };

  // Set up a session so translateStream doesn't try to create a new one
  internals.sessions.set("test-thread", {
    sessionId: "test-session",
    active: true,
    lastUsed: Date.now(),
  });

  await new Promise<void>((resolve, reject) => {
    const subscriber = {
      next: (event: BaseEvent) => {
        events.push(event);
      },
      error: (err: Error) => {
        reject(err);
      },
      complete: () => {
        resolve();
      },
    };

    internals.translateStream(runInput, mockStream, subscriber).catch(reject);
  });

  return events;
}

describe("ClaudeAgentAdapter — TOOL_CALL_START/END pairing", () => {
  it("closes all active tool calls when content_block_stop only arrives for the last one", async () => {
    const adapter = new ClaudeAgentAdapter({ permissionMode: "bypassPermissions" });

    // Simulate the exact pattern from the resp.txt bug report:
    // 4 parallel tool calls, only the last one gets content_block_stop
    const mockStream = asyncIterableFrom([
      // message_start
      messageStart("msg-1"),
      // 4 tool_use content_block_start events arrive consecutively
      // (Claude Agent SDK emits them in this pattern for parallel tool use)
      toolUseStart("tool-1", "Bash"),
      toolUseStart("tool-2", "Bash"),
      toolUseStart("tool-3", "Bash"),
      toolUseStart("tool-4", "Bash"),
      // Only the last tool gets input_json_delta + content_block_stop
      inputJsonDelta('{ "command": "ls" }'),
      contentBlockStop(),
      // message_stop
      messageStop(),
      // Result message (signals run end)
      { type: "result", result: "done", is_error: false, duration_ms: 1000, num_turns: 1, total_cost_usd: 0, usage: {} },
    ]);

    const events = await collectEvents(adapter, {}, mockStream);

    // Count TOOL_CALL_START and TOOL_CALL_END events
    const starts = events.filter((e) => e.type === EventType.TOOL_CALL_START);
    const ends = events.filter((e) => e.type === EventType.TOOL_CALL_END);

    // All 4 TOOL_CALL_STARTs should have been emitted
    expect(starts.length).toBe(4);

    // All 4 TOOL_CALL_ENDs should have been emitted (1 from content_block_stop + 3 from finally cleanup)
    expect(ends.length).toBe(4);

    // Every toolCallId from START should have a matching END
    const startIds = starts.map((e: any) => e.toolCallId);
    const endIds = ends.map((e: any) => e.toolCallId);
    expect(startIds.sort()).toEqual(endIds.sort());
  });

  it("properly pairs START/END when each tool call gets its own content_block_stop", async () => {
    const adapter = new ClaudeAgentAdapter({ permissionMode: "bypassPermissions" });

    // Normal case: each tool call gets content_block_start → deltas → content_block_stop
    const mockStream = asyncIterableFrom([
      messageStart("msg-1"),
      // Tool 1: full lifecycle
      toolUseStart("tool-1", "Bash"),
      inputJsonDelta('{ "command": "ls" }'),
      contentBlockStop(),
      // Tool 2: full lifecycle
      toolUseStart("tool-2", "Read"),
      inputJsonDelta('{ "file_path": "/tmp/test" }'),
      contentBlockStop(),
      messageStop(),
      { type: "result", result: "done", is_error: false, duration_ms: 1000, num_turns: 1, total_cost_usd: 0, usage: {} },
    ]);

    const events = await collectEvents(adapter, {}, mockStream);

    const starts = events.filter((e) => e.type === EventType.TOOL_CALL_START);
    const ends = events.filter((e) => e.type === EventType.TOOL_CALL_END);

    expect(starts.length).toBe(2);
    expect(ends.length).toBe(2);

    const startIds = starts.map((e: any) => e.toolCallId);
    const endIds = ends.map((e: any) => e.toolCallId);
    expect(startIds.sort()).toEqual(endIds.sort());
  });

  it("emits TOOL_CALL_END for a single hanging tool call in finally block", async () => {
    const adapter = new ClaudeAgentAdapter({ permissionMode: "bypassPermissions" });

    // Edge case: tool_use content_block_start arrives but content_block_stop never arrives
    // (stream truncated or error)
    const mockStream = asyncIterableFrom([
      messageStart("msg-1"),
      toolUseStart("tool-hanging", "Bash"),
      // Stream ends abruptly — no content_block_stop, no message_stop, no result
    ]);

    const events = await collectEvents(adapter, {}, mockStream);

    const starts = events.filter((e) => e.type === EventType.TOOL_CALL_START);
    const ends = events.filter((e) => e.type === EventType.TOOL_CALL_END);

    expect(starts.length).toBe(1);
    expect(ends.length).toBe(1);
    expect((starts[0] as any).toolCallId).toBe((ends[0] as any).toolCallId);
  });

  it("emits TOOL_CALL_END for multiple hanging tool calls in finally block", async () => {
    const adapter = new ClaudeAgentAdapter({ permissionMode: "bypassPermissions" });

    // 3 tool_use starts, none get content_block_stop
    const mockStream = asyncIterableFrom([
      messageStart("msg-1"),
      toolUseStart("tool-a", "Bash"),
      toolUseStart("tool-b", "Read"),
      toolUseStart("tool-c", "Bash"),
      // Stream ends — no content_block_stop for any of them
    ]);

    const events = await collectEvents(adapter, {}, mockStream);

    const starts = events.filter((e) => e.type === EventType.TOOL_CALL_START);
    const ends = events.filter((e) => e.type === EventType.TOOL_CALL_END);

    expect(starts.length).toBe(3);
    expect(ends.length).toBe(3);

    const startIds = starts.map((e: any) => e.toolCallId);
    const endIds = ends.map((e: any) => e.toolCallId);
    expect(startIds.sort()).toEqual(endIds.sort());
  });

  it("completes without RUN_ERROR when an interrupted query throws", async () => {
    const adapter = new ClaudeAgentAdapter({});
    const events: BaseEvent[] = [];
    const internals = adapter as unknown as {
      interruptedThreads: Set<string>;
      translateStream(
        input: any,
        messageStream: AsyncIterable<unknown>,
        subscriber: any,
      ): Promise<void>;
    };
    internals.interruptedThreads.add("test-thread");

    await internals.translateStream(
      { threadId: "test-thread", runId: "test-run", messages: [] },
      throwingAsyncIterable(
        new Error(
          "Claude Code returned an error result: [ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use",
        ),
      ),
      {
        next: (event: BaseEvent) => events.push(event),
        error: (err: Error) => {
          throw err;
        },
        complete: () => {},
      },
    );

    expect(events.some((event) => event.type === EventType.RUN_ERROR)).toBe(false);
    expect(events.some((event) => event.type === EventType.RUN_FINISHED)).toBe(false);
  });

  it("completes without RUN_FINISHED when an interrupted query completes", async () => {
    const adapter = new ClaudeAgentAdapter({});
    const events: BaseEvent[] = [];
    const internals = adapter as unknown as {
      interruptedThreads: Set<string>;
      translateStream(
        input: any,
        messageStream: AsyncIterable<unknown>,
        subscriber: any,
      ): Promise<void>;
    };
    internals.interruptedThreads.add("test-thread");

    await internals.translateStream(
      { threadId: "test-thread", runId: "test-run", messages: [] },
      asyncIterableFrom([
        { type: "result", result: "", is_error: false },
      ]),
      {
        next: (event: BaseEvent) => events.push(event),
        error: (err: Error) => {
          throw err;
        },
        complete: () => {},
      },
    );

    expect(events.some((event) => event.type === EventType.RUN_ERROR)).toBe(false);
    expect(events.some((event) => event.type === EventType.RUN_FINISHED)).toBe(false);
  });

  it("does not evict a session captured by an active run", async () => {
    const adapter = new ClaudeAgentAdapter({ maxSessions: 1 });
    const events: BaseEvent[] = [];
    const internals = adapter as unknown as {
      beginSessionUse(threadId: string): void;
      sessions: Map<string, { sessionId: string; active: boolean; lastUsed: number }>;
      translateStream(
        input: any,
        messageStream: AsyncIterable<unknown>,
        subscriber: any,
      ): Promise<void>;
    };
    internals.sessions.set("idle-thread", {
      sessionId: "idle-session",
      active: false,
      lastUsed: 0,
    });
    internals.beginSessionUse("active-thread");

    await internals.translateStream(
      { threadId: "active-thread", runId: "active-run", messages: [] },
      asyncIterableFrom([
        { type: "system", subtype: "init", session_id: "active-session" },
      ]),
      {
        next: (event: BaseEvent) => events.push(event),
        error: (err: Error) => {
          throw err;
        },
        complete: () => {},
      },
    );

    expect(internals.sessions.has("idle-thread")).toBe(false);
    expect(internals.sessions.get("active-thread")).toMatchObject({
      sessionId: "active-session",
      active: false,
    });
  });

  it("interrupt(threadId) only interrupts that thread's query", async () => {
    const adapter = new ClaudeAgentAdapter({});
    const interruptA = vi.fn().mockResolvedValue(undefined);
    const interruptB = vi.fn().mockResolvedValue(undefined);
    const internals = adapter as unknown as {
      activeQueries: Map<string, { interrupt: () => Promise<void> }>;
    };
    internals.activeQueries.set("thread-a", { interrupt: interruptA } as never);
    internals.activeQueries.set("thread-b", { interrupt: interruptB } as never);

    await adapter.interrupt("thread-a");

    expect(interruptA).toHaveBeenCalledTimes(1);
    expect(interruptB).not.toHaveBeenCalled();
  });

  it("interrupt() with no arg interrupts all queries", async () => {
    const adapter = new ClaudeAgentAdapter({});
    const interruptA = vi.fn().mockResolvedValue(undefined);
    const interruptB = vi.fn().mockResolvedValue(undefined);
    const internals = adapter as unknown as {
      activeQueries: Map<string, { interrupt: () => Promise<void> }>;
    };
    internals.activeQueries.set("thread-a", { interrupt: interruptA } as never);
    internals.activeQueries.set("thread-b", { interrupt: interruptB } as never);

    await adapter.interrupt();

    expect(interruptA).toHaveBeenCalledTimes(1);
    expect(interruptB).toHaveBeenCalledTimes(1);
  });

  it("interrupt() starts every query interrupt before waiting for stuck ones", async () => {
    const adapter = new ClaudeAgentAdapter({});
    let resolveA: (() => void) | undefined;
    const interruptA = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveA = resolve;
        }),
    );
    const interruptB = vi.fn().mockResolvedValue(undefined);
    const internals = adapter as unknown as {
      activeQueries: Map<string, { interrupt: () => Promise<void> }>;
    };
    internals.activeQueries.set("thread-a", { interrupt: interruptA } as never);
    internals.activeQueries.set("thread-b", { interrupt: interruptB } as never);

    const interruptPromise = adapter.interrupt();
    await Promise.resolve();

    expect(interruptA).toHaveBeenCalledTimes(1);
    expect(interruptB).toHaveBeenCalledTimes(1);

    resolveA?.();
    await interruptPromise;
  });
});
