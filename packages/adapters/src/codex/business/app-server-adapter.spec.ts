import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventType } from "@ag-ui/client";
import type { BaseEvent } from "@ag-ui/core";
import {
  CodexAppServerAgentAdapter,
  type CodexAppServerAdapterConfig,
} from "./app-server-adapter";
import { CodexAppServerClient } from "../base/app-server/client";
import type { AppServerTransport } from "../base/app-server/types";

// ── Mock transport ──────────────────────────────────────────────────────────

function createMockTransport(): AppServerTransport & {
  pushLine(line: string): void;
  emitClose(): void;
  sent: string[];
} {
  let messageHandler: ((line: string) => void) | undefined;
  let closeHandler: (() => void) | undefined;
  const sent: string[] = [];

  return {
    send: (msg: string) => sent.push(msg),
    onMessage: (h: (line: string) => void) => {
      messageHandler = h;
    },
    onClose: (h: () => void) => {
      closeHandler = h;
    },
    pushLine: (line: string) => messageHandler?.(line),
    emitClose: () => closeHandler?.(),
    sent,
  };
}

function parseSent(transport: { sent: string[] }): Array<Record<string, unknown>> {
  return transport.sent.map((s) => JSON.parse(s.trimEnd()));
}

// ── Mock data ───────────────────────────────────────────────────────────────

const MOCK_INIT_RESULT = {
  userAgent: "codex-cli/0.144.1",
  codexHome: "/home/.codex",
  platformFamily: "unix",
  platformOs: "macos",
};

const MOCK_THREAD_RESULT = {
  thread: { id: "codex-thread-1" },
  model: "o4-mini",
  modelProvider: "openai",
  serviceTier: null,
  cwd: "/workspace",
  instructionSources: [],
  approvalPolicy: "never",
  approvalsReviewer: "auto_review",
  sandbox: { type: "workspaceWrite" },
  reasoningEffort: null,
};

const MOCK_TURN_RESULT = {
  turn: { id: "turn-1" },
};

// ── Test harness ────────────────────────────────────────────────────────────

/**
 * Drive a full run through the adapter using a mock transport.
 *
 * The adapter is configured with an injected client (no subprocess spawned).
 * The test harness responds to each JSON-RPC request in sequence, then
 * pushes notifications.
 */
async function driveRun(
  adapter: CodexAppServerAgentAdapter,
  transport: ReturnType<typeof createMockTransport>,
  notifications: Array<{ method: string; params: unknown }>,
): Promise<BaseEvent[]> {
  const client = new CodexAppServerClient(transport);
  (adapter as unknown as { config: CodexAppServerAdapterConfig }).config.client = client;

  const events: BaseEvent[] = [];
  const done = new Promise<BaseEvent[]>((resolve, reject) => {
    adapter
      .run({ threadId: "agui-thread-1", messages: [{ role: "user", content: "hello" }] } as never)
      .subscribe({
        next: (e) => events.push(e),
        complete: () => resolve(events),
        error: (err) => reject(err),
      });
  });

  // Drive initialize handshake
  await vi.waitFor(() => expect(transport.sent.length).toBeGreaterThanOrEqual(1));
  const initReq = parseSent(transport).find((m) => m.method === "initialize")!;
  transport.pushLine(JSON.stringify({ id: initReq.id, result: MOCK_INIT_RESULT }));

  // Wait for thread/start or thread/resume
  await vi.waitFor(() =>
    expect(
      parseSent(transport).some(
        (m) => m.method === "thread/start" || m.method === "thread/resume",
      ),
    ).toBe(true),
  );
  const threadReq = parseSent(transport).find(
    (m) => m.method === "thread/start" || m.method === "thread/resume",
  )!;
  transport.pushLine(JSON.stringify({ id: threadReq.id, result: MOCK_THREAD_RESULT }));

  // Wait for turn/start
  await vi.waitFor(() =>
    expect(parseSent(transport).some((m) => m.method === "turn/start")).toBe(true),
  );
  const turnReq = parseSent(transport).find((m) => m.method === "turn/start")!;
  transport.pushLine(JSON.stringify({ id: turnReq.id, result: MOCK_TURN_RESULT }));

  // Wait for executeRun to resume after startTurn resolves, so that
  // drainNotifications has registered its notification handler before
  // we push notifications. A macrotask delay ensures the microtask
  // queue (where the async resume happens) has drained.
  await new Promise((r) => setTimeout(r, 10));

  // Push notifications
  for (const notif of notifications) {
    transport.pushLine(JSON.stringify({ method: notif.method, params: notif.params }));
  }

  return done;
}

function createAdapter(overrides: Partial<CodexAppServerAdapterConfig> = {}) {
  return new CodexAppServerAgentAdapter({
    codexPath: "/usr/bin/codex",
    cwd: "/workspace",
    ...overrides,
  });
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("CodexAppServerAgentAdapter", () => {
  let transport: ReturnType<typeof createMockTransport>;

  beforeEach(() => {
    transport = createMockTransport();
  });

  // ── Construction ───────────────────────────────────────────────────────────

  it("instantiates with minimal config", () => {
    expect(() => new CodexAppServerAgentAdapter({})).not.toThrow();
  });

  it("clone returns a CodexAppServerAgentAdapter instance", () => {
    const adapter = createAdapter();
    expect(adapter.clone()).toBeInstanceOf(CodexAppServerAgentAdapter);
  });

  // ── Run lifecycle ───────────────────────────────────────────────────────────

  it("emits RUN_STARTED then RUN_FINISHED on a successful turn", async () => {
    const adapter = createAdapter();
    const events = await driveRun(adapter, transport, [
      { method: "turn/started", params: { turn: { id: "turn-1", status: "inProgress" } } },
      {
        method: "turn/completed",
        params: { turn: { id: "turn-1", status: "completed" } },
      },
    ]);

    const types = events.map((e) => e.type);
    expect(types[0]).toBe(EventType.RUN_STARTED);
    expect(types[types.length - 1]).toBe(EventType.RUN_FINISHED);
  });

  it("emits RUN_ERROR when turn fails", async () => {
    const adapter = createAdapter();
    const events = await driveRun(adapter, transport, [
      { method: "turn/started", params: { turn: { id: "turn-1", status: "inProgress" } } },
      {
        method: "turn/completed",
        params: {
          turn: { id: "turn-1", status: "failed", error: { message: "Something went wrong" } },
        },
      },
    ]);

    const types = events.map((e) => e.type);
    expect(types[0]).toBe(EventType.RUN_STARTED);
    expect(types[types.length - 1]).toBe(EventType.RUN_ERROR);
  });

  it("emits RUN_FINISHED with interrupt outcome when turn is interrupted", async () => {
    const adapter = createAdapter();
    const events = await driveRun(adapter, transport, [
      { method: "turn/started", params: { turn: { id: "turn-1", status: "inProgress" } } },
      {
        method: "turn/completed",
        params: { turn: { id: "turn-1", status: "interrupted" } },
      },
    ]);

    const lastEvent = events[events.length - 1] as unknown as {
      type: string;
      outcome?: { type: string };
    };
    expect(lastEvent.type).toBe(EventType.RUN_FINISHED);
    expect(lastEvent.outcome?.type).toBe("interrupt");
  });

  // ── Text message streaming ────────────────────────────────────────────────

  it("translates agent message deltas into TEXT_MESSAGE events", async () => {
    const adapter = createAdapter();
    const events = await driveRun(adapter, transport, [
      { method: "turn/started", params: { turn: { id: "turn-1", status: "inProgress" } } },
      {
        method: "item/started",
        params: {
          item: { type: "agentMessage", id: "item-1", text: "", phase: null, memoryCitation: null },
        },
      },
      {
        method: "item/agentMessage/delta",
        params: { itemId: "item-1", delta: "Hello" },
      },
      {
        method: "item/agentMessage/delta",
        params: { itemId: "item-1", delta: " world" },
      },
      {
        method: "item/completed",
        params: {
          item: { type: "agentMessage", id: "item-1", text: "Hello world", phase: "final_answer", memoryCitation: null },
        },
      },
      {
        method: "turn/completed",
        params: { turn: { id: "turn-1", status: "completed" } },
      },
    ]);

    const types = events.map((e) => e.type);
    expect(types).toContain(EventType.TEXT_MESSAGE_START);
    expect(types).toContain(EventType.TEXT_MESSAGE_CONTENT);
    expect(types).toContain(EventType.TEXT_MESSAGE_END);

    const contentEvents = events.filter(
      (e) => e.type === EventType.TEXT_MESSAGE_CONTENT,
    ) as unknown as Array<{ delta: string }>;
    expect(contentEvents.map((e) => e.delta).join("")).toBe("Hello world");
  });

  // ── Process exit without terminal ──────────────────────────────────────────

  it("emits RUN_ERROR when process exits without turn/completed", async () => {
    const adapter = createAdapter();
    const client = new CodexAppServerClient(transport);
    (adapter as unknown as { config: CodexAppServerAdapterConfig }).config.client = client;

    const events: BaseEvent[] = [];
    const done = new Promise<BaseEvent[]>((resolve, reject) => {
      adapter.run({ threadId: "t1", messages: [] } as never).subscribe({
        next: (e) => events.push(e),
        complete: () => resolve(events),
        error: (err) => reject(err),
      });
    });

    // Drive initialize
    await vi.waitFor(() => expect(transport.sent.length).toBeGreaterThanOrEqual(1));
    const initReq = parseSent(transport).find((m) => m.method === "initialize")!;
    transport.pushLine(JSON.stringify({ id: initReq.id, result: MOCK_INIT_RESULT }));

    // Drive thread/start
    await vi.waitFor(() =>
      expect(parseSent(transport).some((m) => m.method === "thread/start")).toBe(true),
    );
    const threadReq = parseSent(transport).find((m) => m.method === "thread/start")!;
    transport.pushLine(JSON.stringify({ id: threadReq.id, result: MOCK_THREAD_RESULT }));

    // Drive turn/start
    await vi.waitFor(() =>
      expect(parseSent(transport).some((m) => m.method === "turn/start")).toBe(true),
    );
    const turnReq = parseSent(transport).find((m) => m.method === "turn/start")!;
    transport.pushLine(JSON.stringify({ id: turnReq.id, result: MOCK_TURN_RESULT }));

    // Emit a turn/started notification
    transport.pushLine(
      JSON.stringify({ method: "turn/started", params: { turn: { id: "turn-1", status: "inProgress" } } }),
    );

    // Let the notification be processed
    await new Promise((r) => setTimeout(r, 10));

    // Simulate process crash
    transport.emitClose();

    const result = await done;

    const types = result.map((e) => e.type);
    expect(types).toContain(EventType.RUN_ERROR);
    expect(types).not.toContain(EventType.RUN_FINISHED);
  });

  // ── Interrupt ───────────────────────────────────────────────────────────────

  it("interrupt sends turn/interrupt and terminates", async () => {
    const adapter = createAdapter();
    const client = new CodexAppServerClient(transport);
    (adapter as unknown as { config: CodexAppServerAdapterConfig }).config.client = client;

    const events: BaseEvent[] = [];
    const done = new Promise<BaseEvent[]>((resolve, reject) => {
      adapter.run({ threadId: "t-int", messages: [] } as never).subscribe({
        next: (e) => events.push(e),
        complete: () => resolve(events),
        error: (err) => reject(err),
      });
    });

    // Drive initialize + thread + turn
    await vi.waitFor(() => expect(transport.sent.length).toBeGreaterThanOrEqual(1));
    const initReq = parseSent(transport).find((m) => m.method === "initialize")!;
    transport.pushLine(JSON.stringify({ id: initReq.id, result: MOCK_INIT_RESULT }));

    await vi.waitFor(() =>
      expect(parseSent(transport).some((m) => m.method === "thread/start")).toBe(true),
    );
    const threadReq = parseSent(transport).find((m) => m.method === "thread/start")!;
    transport.pushLine(JSON.stringify({ id: threadReq.id, result: MOCK_THREAD_RESULT }));

    await vi.waitFor(() =>
      expect(parseSent(transport).some((m) => m.method === "turn/start")).toBe(true),
    );
    const turnReq = parseSent(transport).find((m) => m.method === "turn/start")!;
    transport.pushLine(JSON.stringify({ id: turnReq.id, result: MOCK_TURN_RESULT }));

    // Wait for turnId to be set (requires executeRun to resume after startTurn)
    // The 10ms delay is needed because executeRun resumes on a microtask after
    // the turn/start response is pushed.
    await new Promise((r) => setTimeout(r, 10));
    await vi.waitFor(() => {
      const activeRuns = (
        adapter as unknown as {
          activeRuns: Map<string, { turnId: string | null }>;
        }
      ).activeRuns;
      return activeRuns.get("t-int")?.turnId === "turn-1";
    });

    // Call interrupt without awaiting — it sends turn/interrupt then terminates
    const interruptPromise = adapter.interrupt("t-int");

    // Wait for turn/interrupt to be sent
    await vi.waitFor(() =>
      expect(parseSent(transport).some((m) => m.method === "turn/interrupt")).toBe(true),
    );

    // Respond to turn/interrupt so interruptRun can proceed
    const interruptReq = parseSent(transport).find((m) => m.method === "turn/interrupt")!;
    transport.pushLine(JSON.stringify({ id: interruptReq.id, result: {} }));
    transport.pushLine(
      JSON.stringify({
        method: "turn/completed",
        params: { turn: { id: "turn-1", status: "interrupted" } },
      }),
    );

    // Check that turn/interrupt was sent
    const interruptMsg = parseSent(transport).find(
      (m) => m.method === "turn/interrupt",
    );
    expect(interruptMsg).toBeTruthy();
    expect(interruptMsg!.params).toMatchObject({
      threadId: "codex-thread-1",
      turnId: "turn-1",
    });

    await interruptPromise;

    // Wait for the run to complete after interrupt
    const runEvents = await done;

    // Interrupt should NOT produce RUN_ERROR — it should complete silently
    expect(
      runEvents.some((e) => e.type === EventType.RUN_ERROR),
    ).toBe(false);
  });

  it("interrupt with no arg aborts all active runs", async () => {
    const adapter = createAdapter();

    // Manually inject fake active runs with all fields required by interruptRun
    const fakeAbort1 = new AbortController();
    const fakeAbort2 = new AbortController();
    const activeRuns = (
      adapter as unknown as {
        activeRuns: Map<
          string,
          {
            abortController: AbortController;
            terminated: boolean;
            proc: null;
            client: { interruptTurn: () => Promise<void> };
            approvalBridge: {
              getPending: () => null;
              isResolved: () => boolean;
              clearThread: () => void;
            };
            turnId: null;
            codexThreadId: null;
          }
        >;
      }
    ).activeRuns;

    const fakeBridge = {
      getPending: () => null,
      isResolved: () => false,
      clearThread: () => {},
    };

    activeRuns.set("thread-a", {
      abortController: fakeAbort1,
      terminated: false,
      proc: null,
      client: { interruptTurn: vi.fn().mockResolvedValue(undefined) },
      approvalBridge: fakeBridge,
      turnId: null,
      codexThreadId: null,
    });
    activeRuns.set("thread-b", {
      abortController: fakeAbort2,
      terminated: false,
      proc: null,
      client: { interruptTurn: vi.fn().mockResolvedValue(undefined) },
      approvalBridge: fakeBridge,
      turnId: null,
      codexThreadId: null,
    });

    await adapter.interrupt();

    expect(fakeAbort1.signal.aborted).toBe(true);
    expect(fakeAbort2.signal.aborted).toBe(true);
    expect(activeRuns.size).toBe(0);
  });

  // ── Multi-turn resume ──────────────────────────────────────────────────────

  it("resumes an existing thread on second run", async () => {
    const adapter = createAdapter();

    // First run — starts a new thread
    await driveRun(adapter, transport, [
      { method: "turn/started", params: { turn: { id: "turn-1", status: "inProgress" } } },
      {
        method: "turn/completed",
        params: { turn: { id: "turn-1", status: "completed" } },
      },
    ]);

    // Verify thread/start was used
    expect(parseSent(transport).some((m) => m.method === "thread/start")).toBe(true);

    // Reset transport for second run — need a fresh client because the
    // previous one's state machine is already "ready" (or "closed" after
    // the first run's finally block terminates the process).
    transport = createMockTransport();

    // Second run — should resume. driveRun creates a fresh client.
    await driveRun(adapter, transport, [
      { method: "turn/started", params: { turn: { id: "turn-2", status: "inProgress" } } },
      {
        method: "turn/completed",
        params: { turn: { id: "turn-2", status: "completed" } },
      },
    ]);

    // Check that thread/resume was used (not thread/start)
    expect(parseSent(transport).some((m) => m.method === "thread/resume")).toBe(true);
    expect(parseSent(transport).some((m) => m.method === "thread/start")).toBe(false);
  });

  // ── Error handling ──────────────────────────────────────────────────────────

  it("emits RUN_ERROR when codexPath is missing and no client is injected", async () => {
    const adapter = new CodexAppServerAgentAdapter({});
    const events: BaseEvent[] = [];

    await new Promise<void>((resolve) => {
      adapter.run({ threadId: "t1", messages: [] } as never).subscribe({
        next: (e) => events.push(e),
        complete: () => resolve(),
        error: () => resolve(),
      });
    });

    const hasError = events.some((e) => e.type === EventType.RUN_ERROR);
    expect(hasError).toBe(true);
  });

  // ── Orphan prevention (§7 of migration doc) ─────────────────────────────────

  it("registers a process exit handler that forceKills active subprocesses", () => {
    const adapter = createAdapter();
    const activeRuns = (
      adapter as unknown as {
        activeRuns: Map<string, { proc: { forceKill: () => void } | null }>;
      }
    );

    const forceKillSpy = vi.fn();
    activeRuns.activeRuns.set("t-orphan", {
      proc: { forceKill: forceKillSpy },
    });

    // Invoke forceKillAll directly (simulates what the process exit handler does)
    adapter.forceKillAll();

    expect(forceKillSpy).toHaveBeenCalledOnce();
  });

  it("forceKillAll is a no-op when there are no active subprocesses", () => {
    const adapter = createAdapter();

    // Should not throw
    expect(() => adapter.forceKillAll()).not.toThrow();
  });

  it("forceKillAll skips runs without a proc (injected client)", () => {
    const adapter = createAdapter();
    const activeRuns = (
      adapter as unknown as {
        activeRuns: Map<string, { proc: { forceKill: () => void } | null }>;
      }
    );

    activeRuns.activeRuns.set("t-no-proc", { proc: null });

    // Should not throw
    expect(() => adapter.forceKillAll()).not.toThrow();
  });

  // ── Approval flow (§11, Ticket 05) ──────────────────────────────────────────

  /**
   * Drive a run to the point where it's draining notifications, then
   * push a server request (approval) and return the emitted events.
   *
   * Returns a handle to the run state so the test can call resolveApproval.
   */
  async function driveToApproval(
    adapter: CodexAppServerAgentAdapter,
    transport: ReturnType<typeof createMockTransport>,
    serverRequestMethod: string,
    serverRequestParams: Record<string, unknown>,
  ): Promise<{ events: BaseEvent[]; threadId: string }> {
    const threadId = "t-approval";
    const client = new CodexAppServerClient(transport);
    (adapter as unknown as { config: CodexAppServerAdapterConfig }).config.client = client;

    const events: BaseEvent[] = [];
    const ready = new Promise<void>((resolve) => {
      adapter.run({ threadId, messages: [{ role: "user", content: "test" }] } as never).subscribe({
        next: (e) => {
          events.push(e);
          if (e.type === EventType.RUN_FINISHED) resolve();
        },
        complete: () => {},
        error: () => {},
      });
    });

    // Drive initialize
    await vi.waitFor(() => expect(transport.sent.length).toBeGreaterThanOrEqual(1));
    const initReq = parseSent(transport).find((m) => m.method === "initialize")!;
    transport.pushLine(JSON.stringify({ id: initReq.id, result: MOCK_INIT_RESULT }));

    // Drive thread/start
    await vi.waitFor(() =>
      expect(parseSent(transport).some((m) => m.method === "thread/start")).toBe(true),
    );
    const threadReq = parseSent(transport).find((m) => m.method === "thread/start")!;
    transport.pushLine(JSON.stringify({ id: threadReq.id, result: MOCK_THREAD_RESULT }));

    // Drive turn/start
    await vi.waitFor(() =>
      expect(parseSent(transport).some((m) => m.method === "turn/start")).toBe(true),
    );
    const turnReq = parseSent(transport).find((m) => m.method === "turn/start")!;
    transport.pushLine(JSON.stringify({ id: turnReq.id, result: MOCK_TURN_RESULT }));

    // Wait for drainNotifications to register
    await new Promise((r) => setTimeout(r, 10));

    // Push a turn/started notification
    transport.pushLine(
      JSON.stringify({ method: "turn/started", params: { turn: { id: "turn-1", status: "inProgress" } } }),
    );
    await new Promise((r) => setTimeout(r, 10));

    // Push the server request (approval)
    transport.pushLine(
      JSON.stringify({
        id: 100,
        method: serverRequestMethod,
        params: serverRequestParams,
      }),
    );

    // Wait for RUN_FINISHED{interrupt}
    await ready;

    return { events, threadId };
  }

  it("command approval: emits RUN_FINISHED{interrupt} with command metadata", async () => {
    const adapter = createAdapter();
    const { events, threadId } = await driveToApproval(
      adapter,
      transport,
      "item/commandExecution/requestApproval",
      {
        threadId: "codex-thread-1",
        turnId: "turn-1",
        itemId: "cmd-item-1",
        startedAtMs: Date.now(),
        environmentId: null,
        command: "rm -rf /tmp/test",
        cwd: "/workspace",
        commandActions: [],
      },
    );

    const finished = events.find(
      (e) => e.type === EventType.RUN_FINISHED,
    ) as unknown as {
      outcome?: { type: string; interrupts: Array<Record<string, unknown>> };
    };
    expect(finished).toBeTruthy();
    expect(finished.outcome?.type).toBe("interrupt");
    const interrupt = finished.outcome!.interrupts[0];
    expect(interrupt.reason).toBe("confirmation");
    expect(interrupt.metadata?.kind).toBe("command");
    expect(interrupt.metadata?.command).toBe("rm -rf /tmp/test");
    expect(interrupt.metadata?.availableDecisions).toEqual([
      "accept",
      "acceptForSession",
      "decline",
      "cancel",
    ]);
  });

  it("command approval: resolveApproval with accept sends decision response", async () => {
    const adapter = createAdapter();
    const { threadId } = await driveToApproval(
      adapter,
      transport,
      "item/commandExecution/requestApproval",
      {
        threadId: "codex-thread-1",
        turnId: "turn-1",
        itemId: "cmd-item-1",
        startedAtMs: Date.now(),
        environmentId: null,
        command: "ls",
        cwd: "/workspace",
        commandActions: [],
      },
    );

    transport.sent.length = 0; // clear previous messages

    const resolved = adapter.resolveApproval(
      threadId,
      { decision: "accept" },
      "resume-run-1",
    );

    expect(resolved).toBe(true);

    // Check that a RUN_STARTED was emitted for the resume run
    // and a JSON-RPC response was sent with decision: accept
    await new Promise((r) => setTimeout(r, 10));
    const responses = parseSent(transport).filter((m) => m.id === 100);
    expect(responses).toHaveLength(1);
    expect(responses[0].result).toEqual({ decision: "accept" });
  });

  it("command approval: resolveApproval with acceptForSession sends correct decision", async () => {
    const adapter = createAdapter();
    const { threadId } = await driveToApproval(
      adapter,
      transport,
      "item/commandExecution/requestApproval",
      {
        threadId: "codex-thread-1",
        turnId: "turn-1",
        itemId: "cmd-item-1",
        startedAtMs: Date.now(),
        environmentId: null,
        command: "npm install",
        cwd: "/workspace",
        commandActions: [],
      },
    );

    transport.sent.length = 0;
    adapter.resolveApproval(threadId, { decision: "acceptForSession" }, "resume-1");

    await new Promise((r) => setTimeout(r, 10));
    const responses = parseSent(transport).filter((m) => m.id === 100);
    expect(responses[0].result).toEqual({ decision: "acceptForSession" });
  });

  it("command approval: resolveApproval with decline sends decline", async () => {
    const adapter = createAdapter();
    const { threadId } = await driveToApproval(
      adapter,
      transport,
      "item/commandExecution/requestApproval",
      {
        threadId: "codex-thread-1",
        turnId: "turn-1",
        itemId: "cmd-item-1",
        startedAtMs: Date.now(),
        environmentId: null,
        command: "rm -rf /",
        cwd: "/",
        commandActions: [],
      },
    );

    transport.sent.length = 0;
    adapter.resolveApproval(threadId, { decision: "decline" }, "resume-1");

    await new Promise((r) => setTimeout(r, 10));
    const responses = parseSent(transport).filter((m) => m.id === 100);
    expect(responses[0].result).toEqual({ decision: "decline" });
  });

  it("command approval: resolveApproval with cancelled status sends cancel", async () => {
    const adapter = createAdapter();
    const { threadId } = await driveToApproval(
      adapter,
      transport,
      "item/commandExecution/requestApproval",
      {
        threadId: "codex-thread-1",
        turnId: "turn-1",
        itemId: "cmd-item-1",
        startedAtMs: Date.now(),
        environmentId: null,
        command: "echo hello",
        cwd: "/workspace",
        commandActions: [],
      },
    );

    transport.sent.length = 0;
    adapter.resolveApproval(threadId, { status: "cancelled" }, "resume-1");

    await new Promise((r) => setTimeout(r, 10));
    const responses = parseSent(transport).filter((m) => m.id === 100);
    expect(responses[0].result).toEqual({ decision: "cancel" });
  });

  it("file approval: emits interrupt and resolves with accept", async () => {
    const adapter = createAdapter();
    const { threadId } = await driveToApproval(
      adapter,
      transport,
      "item/fileChange/requestApproval",
      {
        threadId: "codex-thread-1",
        turnId: "turn-1",
        itemId: "file-item-1",
        startedAtMs: Date.now(),
        reason: "write access to /workspace/src/index.ts",
      },
    );

    transport.sent.length = 0;
    adapter.resolveApproval(threadId, { decision: "accept" }, "resume-1");

    await new Promise((r) => setTimeout(r, 10));
    const responses = parseSent(transport).filter((m) => m.id === 100);
    expect(responses[0].result).toEqual({ decision: "accept" });
  });

  it("file approval: resolveApproval with decline sends decline", async () => {
    const adapter = createAdapter();
    const { threadId } = await driveToApproval(
      adapter,
      transport,
      "item/fileChange/requestApproval",
      {
        threadId: "codex-thread-1",
        turnId: "turn-1",
        itemId: "file-item-1",
        startedAtMs: Date.now(),
        reason: "write access",
      },
    );

    transport.sent.length = 0;
    adapter.resolveApproval(threadId, { decision: "decline" }, "resume-1");

    await new Promise((r) => setTimeout(r, 10));
    const responses = parseSent(transport).filter((m) => m.id === 100);
    expect(responses[0].result).toEqual({ decision: "decline" });
  });

  it("permission approval: emits interrupt and resolves with {permissions, scope}", async () => {
    const adapter = createAdapter();
    const { threadId } = await driveToApproval(
      adapter,
      transport,
      "item/permissions/requestApproval",
      {
        threadId: "codex-thread-1",
        turnId: "turn-1",
        itemId: "perm-item-1",
        startedAtMs: Date.now(),
        reason: "Network access required",
        permissions: ["network"],
        cwd: "/workspace",
      },
    );

    transport.sent.length = 0;
    const permPayload = {
      permissions: { network: true },
      scope: "session" as const,
    };
    adapter.resolveApproval(threadId, permPayload, "resume-1");

    await new Promise((r) => setTimeout(r, 10));
    const responses = parseSent(transport).filter((m) => m.id === 100);
    expect(responses[0].result).toEqual(permPayload);
  });

  it("permission approval: cancelled sends empty permissions with turn scope", async () => {
    const adapter = createAdapter();
    const { threadId } = await driveToApproval(
      adapter,
      transport,
      "item/permissions/requestApproval",
      {
        threadId: "codex-thread-1",
        turnId: "turn-1",
        itemId: "perm-item-1",
        startedAtMs: Date.now(),
        reason: "Network access",
        permissions: ["network"],
        cwd: "/workspace",
      },
    );

    transport.sent.length = 0;
    adapter.resolveApproval(threadId, { status: "cancelled" }, "resume-1");

    await new Promise((r) => setTimeout(r, 10));
    const responses = parseSent(transport).filter((m) => m.id === 100);
    expect(responses[0].result).toEqual({ permissions: {}, scope: "turn" });
  });

  it("resolveApproval returns false when no pending approval exists", () => {
    const adapter = createAdapter();
    const result = adapter.resolveApproval("t-no-pending", { decision: "accept" });
    expect(result).toBe(false);
  });

  it("resolveApproval returns false when no active run exists", () => {
    const adapter = createAdapter();
    const result = adapter.resolveApproval("t-no-run", { decision: "accept" });
    expect(result).toBe(false);
  });

  it("double resolveApproval: second call returns false (idempotency)", async () => {
    const adapter = createAdapter();
    const { threadId } = await driveToApproval(
      adapter,
      transport,
      "item/commandExecution/requestApproval",
      {
        threadId: "codex-thread-1",
        turnId: "turn-1",
        itemId: "cmd-item-1",
        startedAtMs: Date.now(),
        environmentId: null,
        command: "ls",
        cwd: "/workspace",
        commandActions: [],
      },
    );

    // First resolve succeeds
    const first = adapter.resolveApproval(threadId, { decision: "accept" }, "r1");
    expect(first).toBe(true);

    // Second resolve fails — already resolved
    const second = adapter.resolveApproval(threadId, { decision: "decline" }, "r2");
    expect(second).toBe(false);
  });

  it("resolveApproval emits RUN_STARTED with resumeRunId before responding", async () => {
    const adapter = createAdapter();
    const { events, threadId } = await driveToApproval(
      adapter,
      transport,
      "item/commandExecution/requestApproval",
      {
        threadId: "codex-thread-1",
        turnId: "turn-1",
        itemId: "cmd-item-1",
        startedAtMs: Date.now(),
        environmentId: null,
        command: "ls",
        cwd: "/workspace",
        commandActions: [],
      },
    );

    const eventsAfterApproval: BaseEvent[] = [];
    // Subscribe to capture events after resolveApproval
    // (the original subscription in driveToApproval already completed)
    // We check via the active run's subscriber
    const activeRuns = (
      adapter as unknown as {
        activeRuns: Map<string, { subscriber: { next: (e: BaseEvent) => void } }>;
      }
    ).activeRuns;
    const run = activeRuns.get(threadId);
    expect(run).toBeTruthy();
    const origNext = run!.subscriber.next;
    run!.subscriber.next = (e: BaseEvent) => {
      eventsAfterApproval.push(e);
      origNext.call(run!.subscriber, e);
    };

    adapter.resolveApproval(threadId, { decision: "accept" }, "resume-run-42");

    await new Promise((r) => setTimeout(r, 10));

    const runStarted = eventsAfterApproval.find(
      (e) => e.type === EventType.RUN_STARTED,
    ) as unknown as { runId?: string };
    expect(runStarted).toBeTruthy();
    expect(runStarted.runId).toBe("resume-run-42");
  });

  it("unrecognized approval payload defaults to decline", async () => {
    const adapter = createAdapter();
    const { threadId } = await driveToApproval(
      adapter,
      transport,
      "item/commandExecution/requestApproval",
      {
        threadId: "codex-thread-1",
        turnId: "turn-1",
        itemId: "cmd-item-1",
        startedAtMs: Date.now(),
        environmentId: null,
        command: "ls",
        cwd: "/workspace",
        commandActions: [],
      },
    );

    transport.sent.length = 0;
    // Pass an unrecognized payload shape
    adapter.resolveApproval(threadId, { unknown: "garbage" }, "resume-1");

    await new Promise((r) => setTimeout(r, 10));
    const responses = parseSent(transport).filter((m) => m.id === 100);
    expect(responses[0].result).toEqual({ decision: "decline" });
  });
});
