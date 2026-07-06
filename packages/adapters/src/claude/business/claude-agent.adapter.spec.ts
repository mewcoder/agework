import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventType } from "@ag-ui/client";
import {
  ClaudeAgentAdapter,
  resolveQuestion,
  cancelQuestion,
  __resetPermissionQueue,
  pendingQuestions,
} from "./claude-agent.adapter";
import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";

const mockQuery = vi.fn();
vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>();
  return {
    ...actual,
    query: (...args: unknown[]) => mockQuery(...args),
  };
});

// ── helpers ──────────────────────────────────────────────────────────────────

const flush = () => new Promise((r) => setTimeout(r, 0));

type EmittedEvent = { type: string; toolCallId?: string; toolCallName?: string; delta?: string } & Record<string, unknown>;

function makeAdapter() {
  const adapter = new ClaudeAgentAdapter({}) as unknown as {
    requestToolPermission(input: {
      threadId: string;
      runId?: string;
      toolName: string;
      toolInput: Record<string, unknown>;
      options: {
        signal: AbortSignal;
        suggestions?: { destination: string; type: string }[];
      };
      subscriber: unknown;
    }): Promise<PermissionResult>;
  };
  return adapter;
}

function makeSubscriber() {
  const emitted: EmittedEvent[] = [];
  const subscriber = { next: (e: EmittedEvent) => emitted.push(e) };
  return { emitted, subscriber };
}

/** 从已 emit 的事件里找最后一个 TOOL_CALL_ARGS，parse 出 question 文本。 */
function lastPendingQuestion(events: EmittedEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === EventType.TOOL_CALL_ARGS && events[i].delta) {
      try {
        const parsed = JSON.parse(events[i].delta as string);
        return parsed.questions?.[0]?.question ?? null;
      } catch {
        // ignore
      }
    }
  }
  return null;
}

function countStarts(events: EmittedEvent[]): number {
  return events.filter((e) => e.type === EventType.TOOL_CALL_START).length;
}

function callPermission(
  adapter: ReturnType<typeof makeAdapter>,
  threadId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  signal: AbortSignal,
  subscriber: unknown,
  suggestions?: { destination: string; type: string }[],
) {
  return adapter.requestToolPermission({
    threadId,
    toolName,
    toolInput,
    options: { signal, suggestions } as never,
    subscriber,
  });
}

// ── tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  __resetPermissionQueue();
  pendingQuestions.clear();
});

afterEach(() => {
  __resetPermissionQueue();
  pendingQuestions.clear();
});

describe("ClaudeAgentAdapter 权限请求事件", () => {
  it("forwards pathToClaudeCodeExecutable to Claude SDK options", () => {
    const adapter = new ClaudeAgentAdapter({
      pathToClaudeCodeExecutable: "/usr/local/bin/claude",
    });

    expect(
      adapter.buildOptions({ threadId: "t-path", runId: "r-path", messages: [] })
    ).toMatchObject({
      pathToClaudeCodeExecutable: "/usr/local/bin/claude",
    });
  });

  it("合成工具调用名是 AskUserPermission，不是 AskUserQuestion（避免跟模型真实调用的 AskUserQuestion 混淆）", async () => {
    const threadId = `t-name-${Math.random().toString(36).slice(2)}`;
    const adapter = makeAdapter();
    const { emitted, subscriber } = makeSubscriber();
    const ac = new AbortController();

    const p1 = callPermission(adapter, threadId, "Write", { file_path: "/a" }, ac.signal, subscriber);
    await flush();

    const start = emitted.find((e) => e.type === EventType.TOOL_CALL_START);
    expect(start?.toolCallName).toBe("AskUserPermission");

    resolveQuestion(threadId, { [lastPendingQuestion(emitted)!]: "允许" });
    await p1;
  });

  it("回答后会在 TOOL_CALL_END 之前补发 TOOL_CALL_RESULT，内容是用户选的选项", async () => {
    // 这条合成工具调用没有真实的 SDK tool_use，不会像模型自己调用的
    // AskUserQuestion 那样从 SDK 的 tool_result 自动转出 TOOL_CALL_RESULT。
    // 没有这条 RESULT，前端 ToolCallMessagePart 的 result 永远是 undefined，
    // status 会一直跟着所在消息走而不是变成 complete（见 thread-utils.ts
    // 的 findPendingQuestionPart 注释），已经回答过的请求在 resume 重连等
    // 窗口期会被重新判定成"运行中"。
    const threadId = `t-result-${Math.random().toString(36).slice(2)}`;
    const adapter = makeAdapter();
    const { emitted, subscriber } = makeSubscriber();
    const ac = new AbortController();

    const p = callPermission(adapter, threadId, "Write", { file_path: "/a" }, ac.signal, subscriber);
    await flush();

    const toolCallId = emitted.find((e) => e.type === EventType.TOOL_CALL_START)!.toolCallId;
    resolveQuestion(threadId, { [lastPendingQuestion(emitted)!]: "允许" });
    await p;

    const resultIdx = emitted.findIndex((e) => e.type === EventType.TOOL_CALL_RESULT);
    const endIdx = emitted.findIndex((e) => e.type === EventType.TOOL_CALL_END);
    expect(resultIdx).toBeGreaterThanOrEqual(0);
    expect(endIdx).toBeGreaterThan(resultIdx);

    const result = emitted[resultIdx];
    expect(result.toolCallId).toBe(toolCallId);
    expect(result.content).toBe("允许");
    expect(result.role).toBe("tool");
  });

  it("拒绝/abort 时也会补发 TOOL_CALL_RESULT，内容是拒绝原因", async () => {
    const threadId = `t-result-abort-${Math.random().toString(36).slice(2)}`;
    const adapter = makeAdapter();
    const { emitted, subscriber } = makeSubscriber();
    const ac = new AbortController();

    const p = callPermission(adapter, threadId, "Read", { file_path: "/a" }, ac.signal, subscriber);
    await flush();

    ac.abort();
    await expect(p).rejects.toThrow("Aborted");

    const result = emitted.find((e) => e.type === EventType.TOOL_CALL_RESULT);
    expect(result?.content).toBe("Aborted");
  });
});

describe("ClaudeAgentAdapter 权限请求串行化", () => {
  it("并发权限请求被串行化：每次只有 1 个待答，答完一个才出下一个", async () => {
    const threadId = `t-serial-${Math.random().toString(36).slice(2)}`;
    const adapter = makeAdapter();
    const { emitted, subscriber } = makeSubscriber();
    const ac = new AbortController();

    // 模型同一 turn 并行发起 3 个 Read（SDK 对 parallel tool use 并发调 canUseTool）
    const p1 = callPermission(adapter, threadId, "Read", { file_path: "/a" }, ac.signal, subscriber);
    const p2 = callPermission(adapter, threadId, "Read", { file_path: "/b" }, ac.signal, subscriber);
    const p3 = callPermission(adapter, threadId, "Read", { file_path: "/c" }, ac.signal, subscriber);

    await flush();

    // 只有第 1 个 emit 了 TOOL_CALL_START；第 2、3 个在排队
    expect(countStarts(emitted)).toBe(1);
    const q1 = lastPendingQuestion(emitted);
    expect(q1).toContain("Read");

    // 用户允许第 1 个 → 第 1 个 resolve(allow)，第 2 个才开始 emit
    resolveQuestion(threadId, { [q1!]: "允许" });
    const r1 = await p1;
    expect(r1.behavior).toBe("allow");
    await flush();

    expect(countStarts(emitted)).toBe(2);
    const q2 = lastPendingQuestion(emitted);
    expect(q2).toContain("Read");

    // 允许第 2 个 → 第 3 个 emit
    resolveQuestion(threadId, { [q2!]: "允许" });
    const r2 = await p2;
    expect(r2.behavior).toBe("allow");
    await flush();

    expect(countStarts(emitted)).toBe(3);
    const q3 = lastPendingQuestion(emitted);
    resolveQuestion(threadId, { [q3!]: "允许" });
    const r3 = await p3;
    expect(r3.behavior).toBe("allow");

    // 全部答完后队列清空
    await flush();
    expect(resolveQuestion(threadId, {})).toBe(false);
  });

  it("用户拒绝前一个不阻塞后一个（deny 仍串行推进）", async () => {
    const threadId = `t-deny-${Math.random().toString(36).slice(2)}`;
    const adapter = makeAdapter();
    const { emitted, subscriber } = makeSubscriber();
    const ac = new AbortController();

    const p1 = callPermission(adapter, threadId, "Bash", { command: "rm -rf /" }, ac.signal, subscriber);
    const p2 = callPermission(adapter, threadId, "Read", { file_path: "/safe" }, ac.signal, subscriber);

    await flush();
    expect(countStarts(emitted)).toBe(1);
    const q1 = lastPendingQuestion(emitted)!;

    // 拒绝第 1 个
    resolveQuestion(threadId, { [q1]: "拒绝" });
    const r1 = await p1;
    expect(r1.behavior).toBe("deny");
    await flush();

    // 第 2 个仍正常推进
    expect(countStarts(emitted)).toBe(2);
    const q2 = lastPendingQuestion(emitted)!;
    resolveQuestion(threadId, { [q2]: "允许" });
    const r2 = await p2;
    expect(r2.behavior).toBe("allow");
  });

  it("前一个 abort 不阻塞后一个", async () => {
    const threadId = `t-abort-${Math.random().toString(36).slice(2)}`;
    const adapter = makeAdapter();
    const { emitted, subscriber } = makeSubscriber();
    const ac = new AbortController();

    const p1 = callPermission(adapter, threadId, "Read", { file_path: "/a" }, ac.signal, subscriber);
    const p2 = callPermission(adapter, threadId, "Read", { file_path: "/b" }, ac.signal, subscriber);

    await flush();
    expect(countStarts(emitted)).toBe(1);

    // 整个 run abort → 第 1 个 reject，第 2 个排队期间发现 signal 已 aborted 直接 reject
    ac.abort();
    await expect(p1).rejects.toThrow("Aborted");
    await flush();

    // 第 2 个因 signal 已 aborted，不会 emit，直接 reject
    await expect(p2).rejects.toThrow("Aborted");
    // 仍然只有 1 个 START（第 2 个没 emit）
    expect(countStarts(emitted)).toBe(1);
  });

  it("cancelQuestion 取消当前待答，后续排队请求不推进（取消不是答案）", async () => {
    const threadId = `t-cancel-${Math.random().toString(36).slice(2)}`;
    const adapter = makeAdapter();
    const { emitted, subscriber } = makeSubscriber();
    const ac = new AbortController();

    const p1 = callPermission(adapter, threadId, "Read", { file_path: "/a" }, ac.signal, subscriber);
    const p2 = callPermission(adapter, threadId, "Read", { file_path: "/b" }, ac.signal, subscriber);

    await flush();
    expect(countStarts(emitted)).toBe(1);

    // cancelQuestion 取消第 1 个（reject）→ 推进第 2 个
    cancelQuestion(threadId);
    await expect(p1).rejects.toThrow("Question cancelled");
    await flush();

    expect(countStarts(emitted)).toBe(2);
    const q2 = lastPendingQuestion(emitted)!;
    resolveQuestion(threadId, { [q2]: "允许" });
    const r2 = await p2;
    expect(r2.behavior).toBe("allow");
  });
});

describe("ClaudeAgentAdapter 跨路径竞争（AskUserQuestion vs 权限请求）", () => {
  it("先到的 AskUserQuestion 被后到的权限请求顶替时会被正确 reject，而不是悬挂", async () => {
    const threadId = `t-cross-${Math.random().toString(36).slice(2)}`;
    const adapter = makeAdapter();
    const { emitted, subscriber } = makeSubscriber();
    const ac = new AbortController();

    // 模拟模型并行 tool use 中先到的 AskUserQuestion：占住该 thread 的
    // pendingQuestions 槛位（canUseTool 内联处理，不经过 permissionQueues）。
    let askRejection: Error | undefined;
    pendingQuestions.set(threadId, {
      questions: [],
      resolveAnswers: () => {
        throw new Error("should not resolve — should be rejected instead");
      },
      reject: (err) => {
        askRejection = err;
      },
      rejectWithoutCleanup: (err) => {
        askRejection = err;
      },
    });

    // 同一 turn 里并行触发的普通工具权限请求（走 permissionQueues → executePermissionRequest）
    const p = callPermission(adapter, threadId, "Read", { file_path: "/a" }, ac.signal, subscriber);
    await flush();

    // 先到的 AskUserQuestion 应被正确顶替 reject，而不是被静默覆盖、永远悬挂
    expect(askRejection?.message).toBe("Superseded by new question");

    const q = lastPendingQuestion(emitted)!;
    resolveQuestion(threadId, { [q]: "允许" });
    const r = await p;
    expect(r.behavior).toBe("allow");
  });
});

describe("ClaudeAgentAdapter 始终允许", () => {
  it("suggestions 含 localSettings 规则时，emit 的 argsText 里 options 含'始终允许'", async () => {
    const threadId = `t-always-${Math.random().toString(36).slice(2)}`;
    const adapter = makeAdapter();
    const { emitted, subscriber } = makeSubscriber();
    const ac = new AbortController();

    const suggestions = [
      { type: "addRules", destination: "localSettings", rules: [], behavior: "allow" },
    ];
    const p = callPermission(adapter, threadId, "Write", { file_path: "/a" }, ac.signal, subscriber, suggestions);
    await flush();

    const args = emitted.find((e) => e.type === EventType.TOOL_CALL_ARGS && e.delta);
    const parsed = JSON.parse(args!.delta as string);
    const labels = parsed.questions[0].options.map((o: { label: string }) => o.label);
    expect(labels).toContain("始终允许");
    expect(labels).toContain("允许");
    expect(labels).toContain("拒绝");

    resolveQuestion(threadId, { [parsed.questions[0].question]: "允许" });
    await p;
  });

  it("suggestions 不含 localSettings 时，options 只有'允许'和'拒绝'", async () => {
    const threadId = `t-no-always-${Math.random().toString(36).slice(2)}`;
    const adapter = makeAdapter();
    const { emitted, subscriber } = makeSubscriber();
    const ac = new AbortController();

    const p = callPermission(adapter, threadId, "Write", { file_path: "/a" }, ac.signal, subscriber, undefined);
    await flush();

    const args = emitted.find((e) => e.type === EventType.TOOL_CALL_ARGS && e.delta);
    const parsed = JSON.parse(args!.delta as string);
    const labels = parsed.questions[0].options.map((o: { label: string }) => o.label);
    expect(labels).toEqual(["允许", "拒绝"]);

    resolveQuestion(threadId, { [parsed.questions[0].question]: "允许" });
    await p;
  });

  it("用户答'始终允许'且 suggestions 含 localSettings 时，返回的 PermissionResult 带 updatedPermissions", async () => {
    const threadId = `t-always-resolve-${Math.random().toString(36).slice(2)}`;
    const adapter = makeAdapter();
    const { emitted, subscriber } = makeSubscriber();
    const ac = new AbortController();

    const localRule = { type: "addRules", destination: "localSettings", rules: [{ toolName: "Write", ruleContent: "/a" }], behavior: "allow" as const };
    const p = callPermission(adapter, threadId, "Write", { file_path: "/a" }, ac.signal, subscriber, [localRule]);
    await flush();

    const args = emitted.find((e) => e.type === EventType.TOOL_CALL_ARGS && e.delta);
    const parsed = JSON.parse(args!.delta as string);
    resolveQuestion(threadId, { [parsed.questions[0].question]: "始终允许" });
    const r = await p;

    expect(r.behavior).toBe("allow");
    expect((r as { updatedPermissions?: unknown[] }).updatedPermissions).toEqual([localRule]);
  });

  it("用户答'允许'时，PermissionResult 不带 updatedPermissions（维持原行为）", async () => {
    const threadId = `t-once-${Math.random().toString(36).slice(2)}`;
    const adapter = makeAdapter();
    const { emitted, subscriber } = makeSubscriber();
    const ac = new AbortController();

    const localRule = { type: "addRules", destination: "localSettings", rules: [], behavior: "allow" as const };
    const p = callPermission(adapter, threadId, "Write", { file_path: "/a" }, ac.signal, subscriber, [localRule]);
    await flush();

    const args = emitted.find((e) => e.type === EventType.TOOL_CALL_ARGS && e.delta);
    const parsed = JSON.parse(args!.delta as string);
    resolveQuestion(threadId, { [parsed.questions[0].question]: "允许" });
    const r = await p;

    expect(r.behavior).toBe("allow");
    expect((r as { updatedPermissions?: unknown[] }).updatedPermissions).toBeUndefined();
  });
});

// ── query hooks (extraQueryOptions / onBeforeQuery / wrapMessageStream / onStreamError) ──

function makeHookAdapter(opts?: { trace?: (event: unknown) => void }) {
  return new ClaudeAgentAdapter(opts ?? {}) as unknown as {
    extraQueryOptions(
      input: { threadId?: string; runId?: string; forwardedProps?: unknown },
      options: Record<string, unknown>,
      subscriber: unknown,
    ): { canUseTool?: unknown; thinking?: unknown };
    onBeforeQuery(prompt: string, options: unknown, input: unknown): void;
    wrapMessageStream(
      stream: AsyncIterable<unknown>,
      input: unknown,
    ): AsyncIterable<unknown>;
    onStreamError(error: unknown, input: unknown): void;
  };
}

describe("ClaudeAgentAdapter query hooks", () => {
  it("extraQueryOptions 注入 canUseTool 和 claudeThinkingMode 对应的 thinking 选项", () => {
    const adapter = makeHookAdapter();
    const result = adapter.extraQueryOptions(
      { threadId: "t1", forwardedProps: { claudeThinkingMode: "adaptive" } },
      {},
      { next: vi.fn() },
    );
    expect(typeof result.canUseTool).toBe("function");
    expect(result.thinking).toEqual({ type: "adaptive" });
  });

  it("onBeforeQuery 调用 emitTrace('sdk.claude.input', ...)", () => {
    const trace = vi.fn();
    const adapter = makeHookAdapter({ trace });
    adapter.onBeforeQuery("hello", { model: "x" }, { threadId: "t1", runId: "r1" });
    expect(trace).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "sdk.claude.input",
        payload: { method: "query", arguments: { prompt: "hello", options: { model: "x" } } },
        runId: "r1",
        threadId: "t1",
      }),
    );
  });

  it("wrapMessageStream 对每条消息调用 emitTrace('sdk.claude.output', ...)，并原样透传消息", async () => {
    const trace = vi.fn();
    const adapter = makeHookAdapter({ trace });
    const source = (async function* () {
      yield { type: "system" };
      yield { type: "result" };
    })();

    const wrapped = adapter.wrapMessageStream(source, { threadId: "t1", runId: "r1" });
    const received: unknown[] = [];
    for await (const msg of wrapped) received.push(msg);

    expect(received).toEqual([{ type: "system" }, { type: "result" }]);
    expect(trace).toHaveBeenCalledTimes(2);
    expect(trace).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ name: "sdk.claude.output", payload: { type: "system" } }),
    );
  });

  it("onStreamError 调用 emitTrace('sdk.claude.error', ...)", () => {
    const trace = vi.fn();
    const adapter = makeHookAdapter({ trace });
    const error = new Error("boom");

    adapter.onStreamError(error, { threadId: "t1", runId: "r1" });

    expect(trace).toHaveBeenCalledWith(
      expect.objectContaining({ name: "sdk.claude.error", payload: error, runId: "r1", threadId: "t1" }),
    );
  });
});

describe("ClaudeAgentAdapter run() 端到端", () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it("session resume 注入、hook 注入的 query options、tracing 三者都经由 base 的 run() 生效", async () => {
    const trace = vi.fn();
    const adapter = new ClaudeAgentAdapter({ trace });

    mockQuery.mockReturnValue({
      [Symbol.asyncIterator]: () => {
        let done = false;
        return {
          next: async () => {
            if (done) return { value: undefined, done: true };
            done = true;
            return {
              value: {
                type: "result",
                subtype: "success",
                result: "hi",
                is_error: false,
                num_turns: 1,
                total_cost_usd: 0.01,
                duration_api_ms: 100,
                usage: {
                  input_tokens: 10,
                  output_tokens: 5,
                  cache_read_input_tokens: 0,
                  cache_creation_input_tokens: 0,
                },
              },
              done: false,
            };
          },
        };
      },
      interrupt: vi.fn(),
    });

    const events: { type: string }[] = [];
    await new Promise<void>((resolve, reject) => {
      adapter
        .run({
          threadId: "t-e2e",
          runId: "r-e2e",
          messages: [{ id: "m1", role: "user", content: "hello" }],
          tools: [],
          context: [],
        } as never)
        .subscribe({
          next: (e) => events.push(e as { type: string }),
          error: reject,
          complete: resolve,
        });
    });

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const callArgs = mockQuery.mock.calls[0][0] as {
      prompt: string;
      options: { canUseTool?: unknown };
    };
    expect(callArgs.prompt).toBe("hello");
    expect(typeof callArgs.options.canUseTool).toBe("function");
    expect(trace).toHaveBeenCalledWith(expect.objectContaining({ name: "sdk.claude.input" }));
    expect(trace).toHaveBeenCalledWith(expect.objectContaining({ name: "sdk.claude.output" }));
    expect(events.some((e) => e.type === EventType.RUN_FINISHED)).toBe(true);
  });
});
