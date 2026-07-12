import { describe, it, expect, vi, beforeEach } from "vitest";
import { CodexAppServerClient } from "./client";
import type { AppServerTransport } from "./types";

// ── Mock transport ──────────────────────────────────────────────────────────

function createMockTransport(): AppServerTransport & {
  /** Push a raw line into the transport as if received from stdout. */
  pushLine(line: string): void;
  /** Simulate process exit. */
  emitClose(): void;
  /** All messages sent to the transport (each includes trailing \n). */
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

function lastSentMessage(transport: { sent: string[] }): Record<string, unknown> {
  const raw = transport.sent[transport.sent.length - 1];
  return JSON.parse(raw.trimEnd());
}

// ── Initialize result helper ────────────────────────────────────────────────

const MOCK_INIT_RESULT = {
  userAgent: "codex-cli/0.144.1",
  codexHome: "/home/.codex",
  platformFamily: "unix",
  platformOs: "macos",
};

/** Complete the initialize handshake on the mock transport. */
async function mockInitialize(
  client: CodexAppServerClient,
  transport: ReturnType<typeof createMockTransport>,
): Promise<void> {
  const initPromise = client.initialize({
    clientInfo: { name: "agework", title: "AgeWork", version: "0.1.0" },
  });

  // Wait for the initialize request to be sent
  await vi.waitFor(() => expect(transport.sent.length).toBeGreaterThanOrEqual(1));

  // Respond to initialize
  const initReq = lastSentMessage(transport);
  transport.pushLine(
    JSON.stringify({ id: initReq.id, result: MOCK_INIT_RESULT }),
  );

  await initPromise;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("CodexAppServerClient", () => {
  let transport: ReturnType<typeof createMockTransport>;
  let client: CodexAppServerClient;

  beforeEach(() => {
    transport = createMockTransport();
    client = new CodexAppServerClient(transport);
  });

  // ── State machine ───────────────────────────────────────────────────────

  describe("state machine", () => {
    it("starts in 'created' state", () => {
      expect(client.currentState).toBe("created");
    });

    it("transitions to 'ready' after initialize handshake", async () => {
      await mockInitialize(client, transport);
      expect(client.currentState).toBe("ready");
    });

    it("rejects business requests before initialize", async () => {
      await expect(
        client.request("thread/start", { model: "gpt-5.4" }),
      ).rejects.toThrow(/requires state "ready"/);

      expect(() =>
        client.notify("turn/start", { threadId: "x", input: [] }),
      ).toThrow(/requires state "ready"/);
    });

    it("rejects double initialize", async () => {
      await mockInitialize(client, transport);
      await expect(
        client.initialize({
          clientInfo: { name: "agework", version: "0.1.0" },
        }),
      ).rejects.toThrow(/must be "created"/);
    });

    it("transitions to 'closed' on close()", () => {
      client.close();
      expect(client.currentState).toBe("closed");
    });
  });

  // ── Initialize handshake ────────────────────────────────────────────────

  describe("initialize", () => {
    it("sends initialize request with correct shape", async () => {
      const initPromise = client.initialize({
        clientInfo: { name: "agework", title: "AgeWork", version: "0.1.0" },
        capabilities: { experimentalApi: false },
      });

      await vi.waitFor(() => expect(transport.sent.length).toBeGreaterThanOrEqual(1));

      const initReq = lastSentMessage(transport);
      expect(initReq.method).toBe("initialize");
      expect(initReq.params).toEqual({
        clientInfo: { name: "agework", title: "AgeWork", version: "0.1.0" },
        capabilities: { experimentalApi: false },
      });

      // Respond
      transport.pushLine(
        JSON.stringify({ id: initReq.id, result: MOCK_INIT_RESULT }),
      );
      const result = await initPromise;

      expect(result.userAgent).toBe(MOCK_INIT_RESULT.userAgent);
      expect(result.codexHome).toBe(MOCK_INIT_RESULT.codexHome);
      expect(result.platformFamily).toBe(MOCK_INIT_RESULT.platformFamily);
      expect(result.platformOs).toBe(MOCK_INIT_RESULT.platformOs);
      expect(result.codexVersion).toBe("0.144.1");
      expect(result.versionGate.status).toBe("compatible");

      // Verify initialized notification was sent after the response
      const initializedMsg = JSON.parse(transport.sent[1].trimEnd());
      expect(initializedMsg.method).toBe("initialized");
      expect(initializedMsg).not.toHaveProperty("id");
    });

    it("rejects when server returns an error", async () => {
      const initPromise = client.initialize({
        clientInfo: { name: "agework", version: "0.1.0" },
      });

      await vi.waitFor(() => expect(transport.sent.length).toBeGreaterThanOrEqual(1));

      const initReq = lastSentMessage(transport);
      transport.pushLine(
        JSON.stringify({
          id: initReq.id,
          error: { code: -32600, message: "Invalid request" },
        }),
      );

      await expect(initPromise).rejects.toThrow(/JSON-RPC error -32600/);
      expect(client.currentState).not.toBe("ready");
    });
  });

  // ── Request / response matching ─────────────────────────────────────────

  describe("request/response matching", () => {
    beforeEach(async () => {
      await mockInitialize(client, transport);
    });

    it("assigns monotonically increasing ids", async () => {
      const p1 = client.request("thread/start", {});
      const p2 = client.request("thread/resume", {});

      const req1 = JSON.parse(transport.sent[transport.sent.length - 2].trimEnd());
      const req2 = JSON.parse(transport.sent[transport.sent.length - 1].trimEnd());

      expect(req2.id).toBe(req1.id + 1);

      // Clean up
      transport.pushLine(JSON.stringify({ id: req1.id, result: {} }));
      transport.pushLine(JSON.stringify({ id: req2.id, result: {} }));
      await Promise.all([p1, p2]);
    });

    it("correctly matches out-of-order responses", async () => {
      const p1 = client.request("thread/start", {});
      const p2 = client.request("thread/resume", {});

      const req1 = JSON.parse(transport.sent[transport.sent.length - 2].trimEnd());
      const req2 = JSON.parse(transport.sent[transport.sent.length - 1].trimEnd());

      // Respond in reverse order
      transport.pushLine(
        JSON.stringify({ id: req2.id, result: { thread: { id: "thr_2" } } }),
      );
      transport.pushLine(
        JSON.stringify({ id: req1.id, result: { thread: { id: "thr_1" } } }),
      );

      const [r1, r2] = await Promise.all([p1, p2]);
      expect((r1 as { thread: { id: string } }).thread.id).toBe("thr_1");
      expect((r2 as { thread: { id: string } }).thread.id).toBe("thr_2");
    });

    it("rejects on server error response", async () => {
      const p = client.request("thread/resume", { threadId: "nonexistent" });

      const req = lastSentMessage(transport);
      transport.pushLine(
        JSON.stringify({
          id: req.id,
          error: { code: -32602, message: "Thread not found" },
        }),
      );

      await expect(p).rejects.toThrow(/Thread not found/);
    });

    it("ignores responses for unknown ids (already timed out)", async () => {
      // Send a request with a very short timeout
      const shortClient = new CodexAppServerClient(transport, {
        requestTimeoutMs: 10,
      });
      // Skip initialize — we're testing timeout, not state
      // Manually set state by calling initialize
      const initPromise = shortClient.initialize({
        clientInfo: { name: "test", version: "0" },
      });
      await vi.waitFor(() => expect(transport.sent.length).toBeGreaterThanOrEqual(1));
      const initReq = lastSentMessage(transport);
      transport.pushLine(
        JSON.stringify({ id: initReq.id, result: MOCK_INIT_RESULT }),
      );
      await initPromise;

      const p = shortClient.request("thread/start", {});
      const req = lastSentMessage(transport);

      // Wait for timeout
      await expect(p).rejects.toThrow(/timed out/);

      // Late response — should be silently ignored
      transport.pushLine(JSON.stringify({ id: req.id, result: {} }));
      // No crash, no unhandled rejection
    });
  });

  // ── Timeout ─────────────────────────────────────────────────────────────

  describe("timeout", () => {
    it("rejects timed-out requests and clears pending", async () => {
      const shortClient = new CodexAppServerClient(transport, {
        requestTimeoutMs: 50,
      });
      // Initialize
      const initPromise = shortClient.initialize({
        clientInfo: { name: "test", version: "0" },
      });
      await vi.waitFor(() => expect(transport.sent.length).toBeGreaterThanOrEqual(1));
      const initReq = lastSentMessage(transport);
      transport.pushLine(
        JSON.stringify({ id: initReq.id, result: MOCK_INIT_RESULT }),
      );
      await initPromise;

      const p = shortClient.request("thread/start", {});
      await expect(p).rejects.toThrow(/timed out after 50ms/);
    });
  });

  // ── Process exit ────────────────────────────────────────────────────────

  describe("process exit", () => {
    it("rejects all pending requests when transport closes", async () => {
      await mockInitialize(client, transport);

      const p1 = client.request("thread/start", {});
      const p2 = client.request("turn/start", {});

      // Simulate process exit
      transport.emitClose();

      await expect(p1).rejects.toThrow(/Process exited/);
      await expect(p2).rejects.toThrow(/Process exited/);
    });

    it("fires onClose handlers when transport closes", async () => {
      const handler = vi.fn();
      client.onClose(handler);

      transport.emitClose();
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("does not fire onClose twice on close() after transport close", () => {
      const handler = vi.fn();
      client.onClose(handler);

      transport.emitClose();
      client.close(); // Already closed

      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  // ── Invalid JSON ────────────────────────────────────────────────────────

  describe("invalid JSON handling", () => {
    it("increments parseErrorCount on invalid JSON and continues reading", async () => {
      await mockInitialize(client, transport);

      const notificationHandler = vi.fn();
      client.onNotification(notificationHandler);

      // Push invalid JSON
      transport.pushLine("this is not json {{{");
      transport.pushLine("also not valid");

      expect(client.parseErrors).toBe(2);

      // Push a valid notification — should still be received
      transport.pushLine(
        JSON.stringify({ method: "turn/started", params: { turn: { id: "t1" } } }),
      );

      expect(notificationHandler).toHaveBeenCalledWith("turn/started", {
        turn: { id: "t1" },
      });
    });

    it("does not crash on null / array / primitive JSON", async () => {
      await mockInitialize(client, transport);

      transport.pushLine("null");
      transport.pushLine("42");
      transport.pushLine("[]");
      transport.pushLine('"string"');

      expect(client.parseErrors).toBe(4);
    });

    it("handles messages without method or id gracefully", async () => {
      await mockInitialize(client, transport);

      transport.pushLine(JSON.stringify({}));
      transport.pushLine(JSON.stringify({ foo: "bar" }));

      expect(client.parseErrors).toBe(2);
    });
  });

  // ── Notification dispatch ───────────────────────────────────────────────

  describe("notification dispatch", () => {
    beforeEach(async () => {
      await mockInitialize(client, transport);
    });

    it("dispatches notifications to handlers", () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      const unsub1 = client.onNotification(handler1);
      client.onNotification(handler2);

      transport.pushLine(
        JSON.stringify({ method: "turn/completed", params: { status: "completed" } }),
      );

      expect(handler1).toHaveBeenCalledWith("turn/completed", {
        status: "completed",
      });
      expect(handler2).toHaveBeenCalledWith("turn/completed", {
        status: "completed",
      });

      // Unsubscribe handler1
      unsub1();

      transport.pushLine(
        JSON.stringify({ method: "thread/started", params: {} }),
      );

      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).toHaveBeenCalledTimes(2);
    });
  });

  // ── Server request dispatch ─────────────────────────────────────────────

  describe("server request dispatch", () => {
    beforeEach(async () => {
      await mockInitialize(client, transport);
    });

    it("dispatches server requests (with id) to handlers", () => {
      const handler = vi.fn();
      client.onServerRequest(handler);

      const serverReq = {
        method: "item/commandExecution/requestApproval",
        id: "srv_42",
        params: { command: "rm -rf /", availableDecisions: ["accept", "decline"] },
      };

      transport.pushLine(JSON.stringify(serverReq));

      expect(handler).toHaveBeenCalledWith(
        "item/commandExecution/requestApproval",
        "srv_42",
        { command: "rm -rf /", availableDecisions: ["accept", "decline"] },
      );
    });

    it("can respond to server requests", () => {
      client.respondToServerRequest("srv_42", { decision: "accept" });

      const sent = lastSentMessage(transport);
      expect(sent.id).toBe("srv_42");
      expect(sent.result).toEqual({ decision: "accept" });
      expect(sent).not.toHaveProperty("method");
    });

    it("can respond with error to server requests", () => {
      client.respondToServerRequestError("srv_42", {
        code: -32603,
        message: "Internal error",
      });

      const sent = lastSentMessage(transport);
      expect(sent.id).toBe("srv_42");
      expect(sent.error).toEqual({ code: -32603, message: "Internal error" });
    });
  });

  // ── close() ─────────────────────────────────────────────────────────────

  describe("close()", () => {
    it("rejects all pending on close()", async () => {
      await mockInitialize(client, transport);

      const p = client.request("thread/start", {});

      client.close();

      await expect(p).rejects.toThrow(/Client closed/);
    });

    it("is idempotent", () => {
      client.close();
      client.close();
      expect(client.currentState).toBe("closed");
    });
  });

  // ── Trace ───────────────────────────────────────────────────────────────

  describe("trace", () => {
    it("emits trace entries for sent requests", async () => {
      const traceSink = vi.fn();
      const tracedClient = new CodexAppServerClient(transport, {
        trace: traceSink,
      });

      const initPromise = tracedClient.initialize({
        clientInfo: { name: "agework", version: "0.1.0" },
      });
      await vi.waitFor(() => expect(transport.sent.length).toBeGreaterThanOrEqual(1));

      const reqTrace = traceSink.mock.calls.find(
        ([t]) => t.direction === "client_to_server" && t.kind === "request",
      );
      expect(reqTrace).toBeDefined();
      expect(reqTrace![0].method).toBe("initialize");

      // Complete handshake
      const initReq = lastSentMessage(transport);
      transport.pushLine(
        JSON.stringify({ id: initReq.id, result: MOCK_INIT_RESULT }),
      );
      await initPromise;

      // Verify initialized notification trace
      const notifyTrace = traceSink.mock.calls.find(
        ([t]) => t.direction === "client_to_server" && t.kind === "notification",
      );
      expect(notifyTrace).toBeDefined();
      expect(notifyTrace![0].method).toBe("initialized");
    });

    it("emits trace entries for received messages", async () => {
      const traceSink = vi.fn();
      const tracedClient = new CodexAppServerClient(transport, {
        trace: traceSink,
      });

      await mockInitialize(tracedClient, transport);

      // Push a notification
      transport.pushLine(
        JSON.stringify({ method: "turn/started", params: {} }),
      );

      const notifTrace = traceSink.mock.calls.find(
        ([t]) => t.direction === "server_to_client" && t.kind === "notification",
      );
      expect(notifTrace).toBeDefined();
      expect(notifTrace![0].method).toBe("turn/started");
    });
  });

  // ── Thread/Turn typed API ──────────────────────────────────────────────

  describe("Thread/Turn typed API", () => {
    beforeEach(async () => {
      await mockInitialize(client, transport);
    });

    it("startThread sends thread/start and returns typed response", async () => {
      const threadParams = {
        model: "o3",
        cwd: "/tmp/project",
        approvalPolicy: "on-request" as const,
      };

      const promise = client.startThread(threadParams);

      // Verify request shape
      await vi.waitFor(() => expect(transport.sent.length).toBeGreaterThanOrEqual(1));
      const req = lastSentMessage(transport);
      expect(req.method).toBe("thread/start");
      expect(req.params).toEqual(threadParams);

      // Respond with a thread
      const threadResponse = {
        thread: {
          id: "thr_abc123",
          sessionId: "sess_1",
          forkedFromId: null,
          parentThreadId: null,
          preview: "Hello",
          ephemeral: false,
          modelProvider: "openai",
          createdAt: 1700000000,
          updatedAt: 1700000000,
          recencyAt: 1700000000,
          status: { type: "idle" },
          path: null,
          cwd: { value: "/tmp/project" },
          cliVersion: "0.144.1",
          source: "app-server",
          threadSource: null,
          agentNickname: null,
          agentRole: null,
          gitInfo: null,
          name: null,
          turns: [],
        },
        model: "o3",
        modelProvider: "openai",
        serviceTier: null,
        cwd: { value: "/tmp/project" },
        instructionSources: [],
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandbox: { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
        reasoningEffort: null,
      };

      transport.pushLine(JSON.stringify({ id: req.id, result: threadResponse }));

      const result = await promise;
      expect(result.thread.id).toBe("thr_abc123");
      expect(result.model).toBe("o3");
      expect(result.approvalPolicy).toBe("on-request");
    });

    it("resumeThread sends thread/resume with threadId", async () => {
      const promise = client.resumeThread({ threadId: "thr_existing" });

      const req = lastSentMessage(transport);
      expect(req.method).toBe("thread/resume");
      expect(req.params).toEqual({ threadId: "thr_existing" });

      // Respond
      transport.pushLine(
        JSON.stringify({
          id: req.id,
          result: {
            thread: { id: "thr_existing", turns: [] },
            model: "o3",
            modelProvider: "openai",
            serviceTier: null,
            cwd: { value: "/tmp" },
            instructionSources: [],
            approvalPolicy: "on-request",
            approvalsReviewer: "user",
            sandbox: { type: "readOnly", networkAccess: false },
            reasoningEffort: null,
          },
        }),
      );

      const result = await promise;
      expect(result.thread.id).toBe("thr_existing");
    });

    it("resumeThread does NOT silently create a new thread on error", async () => {
      const promise = client.resumeThread({ threadId: "thr_nonexistent" });

      const req = lastSentMessage(transport);
      transport.pushLine(
        JSON.stringify({
          id: req.id,
          error: { code: -32602, message: "Thread not found: thr_nonexistent" },
        }),
      );

      await expect(promise).rejects.toThrow(/Thread not found/);
    });

    it("startTurn sends turn/start with input array", async () => {
      const turnParams = {
        threadId: "thr_abc",
        input: [{ type: "text" as const, text: "Hello world", text_elements: [] }],
      };

      const promise = client.startTurn(turnParams);

      const req = lastSentMessage(transport);
      expect(req.method).toBe("turn/start");
      expect(req.params).toEqual(turnParams);

      // Respond
      transport.pushLine(
        JSON.stringify({
          id: req.id,
          result: { turn: { id: "turn_1", items: [], itemsView: "summary", status: "inProgress", error: null, startedAt: 1700000000, completedAt: null, durationMs: null } },
        }),
      );

      const result = await promise;
      expect(result.turn.id).toBe("turn_1");
      expect(result.turn.status).toBe("inProgress");
    });

    it("interruptTurn sends turn/interrupt and resolves on empty result", async () => {
      const promise = client.interruptTurn({ threadId: "thr_abc", turnId: "turn_1" });

      const req = lastSentMessage(transport);
      expect(req.method).toBe("turn/interrupt");
      expect(req.params).toEqual({ threadId: "thr_abc", turnId: "turn_1" });

      // Server responds with empty object
      transport.pushLine(JSON.stringify({ id: req.id, result: {} }));

      await expect(promise).resolves.toBeUndefined();
    });

    it("interruptTurn rejects on server error", async () => {
      const promise = client.interruptTurn({ threadId: "thr_abc", turnId: "turn_1" });

      const req = lastSentMessage(transport);
      transport.pushLine(
        JSON.stringify({
          id: req.id,
          error: { code: -32601, message: "Turn not in progress" },
        }),
      );

      await expect(promise).rejects.toThrow(/Turn not in progress/);
    });
  });

  // ── Version gate ────────────────────────────────────────────────────────

  describe("version gate", () => {
    it("reports codexVersion and compatible status after initialize", async () => {
      await mockInitialize(client, transport);
      expect(client.reportedCodexVersion).toBe("0.144.1");
    });

    it("allows patch-different versions (compatible)", async () => {
      const initPromise = client.initialize({
        clientInfo: { name: "agework", version: "0.1.0" },
      });

      await vi.waitFor(() => expect(transport.sent.length).toBeGreaterThanOrEqual(1));
      const initReq = lastSentMessage(transport);

      transport.pushLine(
        JSON.stringify({
          id: initReq.id,
          result: {
            userAgent: "codex-cli/0.144.2",
            codexHome: "/home/.codex",
            platformFamily: "unix",
            platformOs: "macos",
          },
        }),
      );

      const result = await initPromise;
      expect(result.codexVersion).toBe("0.144.2");
      expect(result.versionGate.status).toBe("compatible");
      expect(client.currentState).toBe("ready");
    });

    it("allows minor drift as degraded (non-blocking)", async () => {
      const initPromise = client.initialize({
        clientInfo: { name: "agework", version: "0.1.0" },
      });

      await vi.waitFor(() => expect(transport.sent.length).toBeGreaterThanOrEqual(1));
      const initReq = lastSentMessage(transport);

      transport.pushLine(
        JSON.stringify({
          id: initReq.id,
          result: {
            userAgent: "codex-cli/0.145.0",
            codexHome: "/home/.codex",
            platformFamily: "unix",
            platformOs: "macos",
          },
        }),
      );

      const result = await initPromise;
      expect(result.codexVersion).toBe("0.145.0");
      expect(result.versionGate.status).toBe("degraded");
      expect(client.currentState).toBe("ready");
    });

    it("blocks major version mismatch in strict mode", async () => {
      const strictClient = new CodexAppServerClient(transport, {
        versionGate: { generatedVersion: "0.144.1", strict: true },
      });

      const initPromise = strictClient.initialize({
        clientInfo: { name: "agework", version: "0.1.0" },
      });

      await vi.waitFor(() => expect(transport.sent.length).toBeGreaterThanOrEqual(1));
      const initReq = lastSentMessage(transport);

      transport.pushLine(
        JSON.stringify({
          id: initReq.id,
          result: {
            userAgent: "codex-cli/1.0.0",
            codexHome: "/home/.codex",
            platformFamily: "unix",
            platformOs: "macos",
          },
        }),
      );

      await expect(initPromise).rejects.toThrow(/version mismatch/);
      expect(strictClient.currentState).not.toBe("ready");
    });

    it("allows major version mismatch in non-strict mode", async () => {
      const nonStrictClient = new CodexAppServerClient(transport, {
        versionGate: { generatedVersion: "0.144.1", strict: false },
      });

      const initPromise = nonStrictClient.initialize({
        clientInfo: { name: "agework", version: "0.1.0" },
      });

      await vi.waitFor(() => expect(transport.sent.length).toBeGreaterThanOrEqual(1));
      const initReq = lastSentMessage(transport);

      transport.pushLine(
        JSON.stringify({
          id: initReq.id,
          result: {
            userAgent: "codex-cli/2.0.0",
            codexHome: "/home/.codex",
            platformFamily: "unix",
            platformOs: "macos",
          },
        }),
      );

      const result = await initPromise;
      expect(result.versionGate.status).toBe("incompatible");
      expect(nonStrictClient.currentState).toBe("ready");
    });

    it("degrades (non-blocking) when userAgent has no parseable version", async () => {
      const initPromise = client.initialize({
        clientInfo: { name: "agework", version: "0.1.0" },
      });

      await vi.waitFor(() => expect(transport.sent.length).toBeGreaterThanOrEqual(1));
      const initReq = lastSentMessage(transport);

      transport.pushLine(
        JSON.stringify({
          id: initReq.id,
          result: {
            userAgent: "unknown-agent",
            codexHome: "/home/.codex",
            platformFamily: "unix",
            platformOs: "macos",
          },
        }),
      );

      const result = await initPromise;
      expect(result.versionGate.status).toBe("degraded");
      expect(result.codexVersion).toBeNull();
      expect(client.currentState).toBe("ready");
    });
  });
});
