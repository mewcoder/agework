/**
 * Codex app-server JSON-RPC client.
 *
 * Framework-agnostic (no @nestjs/*). Owns:
 * - Monotonically increasing request id
 * - `pendingRequests: Map<id, { resolve, reject, timer }>`
 * - Response / Notification / ServerRequest routing
 * - Request-level timeout
 * - Initialize state machine (created → ready)
 * - Raw trace interface
 *
 * §8 of the migration doc is the authoritative spec for this module.
 */

import type {
  AppServerTransport,
  CodexAppServerClientState,
  CodexAppServerTrace,
  CodexAppServerTraceSink,
  JsonRpcError,
  JsonRpcResponse,
  JsonRpcServerRequest,
  PendingRequest,
  RequestId,
  VersionGateConfig,
  VersionGateResult,
} from "./types";
import type { UserInput } from "./generated/v2/UserInput";
import type { AskForApproval } from "./generated/v2/AskForApproval";
import type { SandboxPolicy } from "./generated/v2/SandboxPolicy";
import type { SandboxMode } from "./generated/v2/SandboxMode";
import type { ApprovalsReviewer } from "./generated/v2/ApprovalsReviewer";
import type { ReasoningEffort } from "./generated/ReasoningEffort";
import type { Personality } from "./generated/Personality";
import type { ReasoningSummary } from "./generated/ReasoningSummary";
import type { AbsolutePathBuf } from "./generated/AbsolutePathBuf";
import type { LegacyAppPathString } from "./generated/LegacyAppPathString";
import type { Thread } from "./generated/v2/Thread";
import type { Turn } from "./generated/v2/Turn";
import { CODEX_GENERATED_VERSION } from "./version";
import {
  checkVersionGate,
  enforceVersionGate,
  extractCodexVersion,
} from "./version-gate";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** Safety cap: a single JSON-RPC line longer than this is skipped (§19). */
const MAX_LINE_LENGTH = 1_000_000;

export type CodexAppServerClientConfig = {
  /** Per-request timeout in ms. Default 30000. */
  requestTimeoutMs?: number;
  /** Raw protocol trace callback (§15). */
  trace?: CodexAppServerTraceSink;
  /**
   * Version gate configuration (§9, 决策1). When omitted, uses the
   * `CODEX_GENERATED_VERSION` as `generatedVersion` and `strict: true`.
   */
  versionGate?: VersionGateConfig;
};

/**
 * The result of an `initialize` handshake. Matches the generated
 * `InitializeResponse` type from `codex app-server generate-ts` (0.144.1).
 *
 * `codexVersion` is extracted from `userAgent` for the version gate (§9).
 */
export type InitializeResult = {
  userAgent: string;
  codexHome: string;
  platformFamily: string;
  platformOs: string;
  /** Extracted codex version (e.g. `"0.144.1"`) for the version gate. */
  codexVersion: string | null;
  /** Result of the version gate check. */
  versionGate: VersionGateResult;
};

// ── Thread/Turn parameter & response types ──────────────────────────────────

/** Response shape for `thread/start` and `thread/resume`. */
export type ThreadResponse = {
  thread: Thread;
  model: string;
  modelProvider: string;
  serviceTier: string | null;
  cwd: AbsolutePathBuf;
  instructionSources: LegacyAppPathString[];
  approvalPolicy: AskForApproval;
  approvalsReviewer: ApprovalsReviewer;
  sandbox: SandboxPolicy;
  reasoningEffort: ReasoningEffort | null;
};

/** Response shape for `turn/start`. */
export type TurnStartResponse = {
  turn: Turn;
};

/** Params for `thread/start`. */
export type ThreadStartParams = {
  model?: string | null;
  modelProvider?: string | null;
  serviceTier?: string | null;
  cwd?: string;
  approvalPolicy?: AskForApproval;
  approvalsReviewer?: ApprovalsReviewer;
  sandbox?: SandboxMode;
  config?: Record<string, unknown> | null;
  serviceName?: string | null;
  baseInstructions?: string | null;
  developerInstructions?: string | null;
  personality?: Personality;
  ephemeral?: boolean;
  sessionStartSource?: string | null;
  threadSource?: string | null;
};

/** Params for `thread/resume`. */
export type ThreadResumeParams = {
  threadId: string;
  model?: string | null;
  modelProvider?: string | null;
  serviceTier?: string | null;
  cwd?: string;
  approvalPolicy?: AskForApproval;
  approvalsReviewer?: ApprovalsReviewer;
  sandbox?: SandboxMode;
  config?: Record<string, unknown> | null;
  baseInstructions?: string | null;
  developerInstructions?: string | null;
  personality?: Personality;
};

/** Params for `turn/start`. */
export type TurnStartParams = {
  threadId: string;
  clientUserMessageId?: string | null;
  input: UserInput[];
  cwd?: string;
  approvalPolicy?: AskForApproval;
  approvalsReviewer?: ApprovalsReviewer;
  sandboxPolicy?: SandboxPolicy;
  model?: string | null;
  serviceTier?: string | null;
  effort?: ReasoningEffort | null;
  summary?: ReasoningSummary | null;
  personality?: Personality;
  outputSchema?: Record<string, unknown> | null;
};

/** Params for `turn/interrupt`. */
export type TurnInterruptParams = {
  threadId: string;
  turnId: string;
};

/** Params for the `initialize` request (simplified — full shape in generated types). */
export type InitializeParams = {
  clientInfo: {
    name: string;
    title?: string | null;
    version: string;
  };
  capabilities?: {
    experimentalApi?: boolean;
    requestAttestation?: boolean;
    optOutNotificationMethods?: string[];
  };
};

/**
 * JSON-RPC 2.0 client for `codex app-server` over newline-delimited JSON.
 *
 * Wire format: `{"method":"thread/start","id":1,"params":{...}}\n`
 * (the `"jsonrpc":"2.0"` header is omitted on the wire per protocol spec).
 *
 * The client is constructed with an {@link AppServerTransport} (typically
 * backed by a `CodexAppServerProcess`). After construction:
 *
 * 1. Call {@link initialize} to perform the handshake.
 * 2. Use {@link request} / {@link notify} for Thread/Turn methods.
 * 3. Use {@link onNotification} / {@link onServerRequest} to receive
 *    server-pushed events and approval requests.
 * 4. Call {@link close} to reject all pending and mark closed.
 */
export class CodexAppServerClient {
  private nextId = 0;
  private readonly pending = new Map<RequestId, PendingRequest>();
  private state: CodexAppServerClientState = "created";
  private readonly notificationHandlers = new Set<
    (method: string, params: unknown) => void
  >();
  private readonly serverRequestHandlers = new Set<
    (method: string, id: RequestId, params: unknown) => void
  >();
  private readonly closeHandlers = new Set<() => void>();
  private parseErrorCount = 0;
  private readonly requestTimeoutMs: number;
  private readonly trace?: CodexAppServerTraceSink;
  private readonly versionGateConfig: VersionGateConfig;
  /** The codex version reported by the server, or null if not yet initialized. */
  private codexVersion: string | null = null;

  constructor(
    private readonly transport: AppServerTransport,
    config: CodexAppServerClientConfig = {},
  ) {
    this.requestTimeoutMs =
      config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.trace = config.trace;
    this.versionGateConfig = config.versionGate ?? {
      generatedVersion: CODEX_GENERATED_VERSION,
      // ADR-0001 decision 3: "Registered/用户自带 codex 为 best-effort,不阻塞"
      // Default non-strict: version mismatch logs a warning but does not throw.
      // Set strict: true only in controlled environments (e.g. Docker with
      // a known codex version).
      strict: false,
    };
    this.transport.onMessage((line) => this.handleLine(line));
    this.transport.onClose(() => this.handleTransportClose());
  }

  /** The codex version reported by the server (available after `initialize`). */
  get reportedCodexVersion(): string | null {
    return this.codexVersion;
  }

  /** Current state machine position. */
  get currentState(): CodexAppServerClientState {
    return this.state;
  }

  /** Number of unparseable lines received (§19 metric). */
  get parseErrors(): number {
    return this.parseErrorCount;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Perform the `initialize` → `initialized` handshake (§8, §9).
   *
   * Sends `initialize` request, waits for the response, extracts the codex
   * version from `userAgent`, runs the version gate (【决策1】), then sends
   * the `initialized` notification. After this returns, the client is in
   * `ready` state and Thread/Turn methods are allowed.
   *
   * @throws if called more than once, when the server returns an error, or
   *         when the version gate rejects (strict mode, incompatible version).
   */
  async initialize(params: InitializeParams): Promise<InitializeResult> {
    if (this.state !== "created") {
      throw new Error(
        `initialize() called in state "${this.state}" — must be "created"`,
      );
    }

    this.state = "initialize_sent";

    const capabilities = {
      experimentalApi: false,
      ...(params.capabilities ?? {}),
    };

    const result = (await this.doRequest("initialize", {
      clientInfo: params.clientInfo,
      capabilities,
    })) as Omit<InitializeResult, "codexVersion" | "versionGate">;

    // ── Version gate (§9, 决策1) ──
    const codexVersion = extractCodexVersion(result.userAgent);
    this.codexVersion = codexVersion;
    const versionGate = checkVersionGate(this.versionGateConfig, codexVersion);
    enforceVersionGate(versionGate, this.versionGateConfig);

    this.state = "initialize_resolved";
    this.doNotify("initialized", {});
    this.state = "ready";

    return { ...result, codexVersion, versionGate };
  }

  // ── Thread API ────────────────────────────────────────────────────────────

  /**
   * Start a new thread (`thread/start`).
   *
   * Creates a new conversation thread on the server. The returned
   * `thread.id` is the canonical identifier for all subsequent turn and
   * notification operations.
   */
  async startThread(params: ThreadStartParams): Promise<ThreadResponse> {
    return (await this.request("thread/start", params)) as ThreadResponse;
  }

  /**
   * Resume an existing thread (`thread/resume`).
   *
   * Loads a previously created thread by its `threadId`. If the thread does
   * not exist, the server returns a JSON-RPC error — the client does **not**
   * silently create a new thread.
   *
   * @throws Error with message containing the server's error when the thread
   *         is not found.
   */
  async resumeThread(params: ThreadResumeParams): Promise<ThreadResponse> {
    return (await this.request("thread/resume", params)) as ThreadResponse;
  }

  // ── Turn API ──────────────────────────────────────────────────────────────

  /**
   * Start a new turn (`turn/start`).
   *
   * Submits user input to the specified thread and begins model execution.
   * The server will stream notifications (token output, tool calls, etc.)
   * until the turn completes.
   */
  async startTurn(params: TurnStartParams): Promise<TurnStartResponse> {
    return (await this.request("turn/start", params)) as TurnStartResponse;
  }

  /**
   * Interrupt a running turn (`turn/interrupt`).
   *
   * Requests the server to stop the current turn. The server will respond
   * with an empty result (`{}`), and a `turn/completed` notification with
   * `status: "interrupted"` will follow.
   */
  async interruptTurn(params: TurnInterruptParams): Promise<void> {
    await this.request("turn/interrupt", params);
  }

  /**
   * Send a JSON-RPC request and await the response.
   *
   * Only allowed when the client is in `ready` state (after {@link initialize}).
   */
  async request(method: string, params?: unknown): Promise<unknown> {
    this.requireReady(method);
    return this.doRequest(method, params);
  }

  /**
   * Send a JSON-RPC notification (no response expected).
   *
   * Only allowed when the client is in `ready` state.
   */
  notify(method: string, params?: unknown): void {
    this.requireReady(method);
    this.doNotify(method, params);
  }

  /**
   * Respond to a server-initiated request with a successful result.
   *
   * @param id — the `id` from the server request.
   * @param result — the result payload (e.g. `{ decision: "accept" }`).
   */
  respondToServerRequest(id: RequestId, result: unknown): void {
    const message = JSON.stringify({ id, result });
    this.transport.send(message + "\n");
    this.emitTrace("client_to_server", "response", undefined, id, result);
  }

  /**
   * Respond to a server-initiated request with an error.
   */
  respondToServerRequestError(id: RequestId, error: JsonRpcError): void {
    const message = JSON.stringify({ id, error });
    this.transport.send(message + "\n");
    this.emitTrace("client_to_server", "response", undefined, id, { error });
  }

  /**
   * Subscribe to server notifications (messages with `method` but no `id`).
   * @returns an unsubscribe function.
   */
  onNotification(
    handler: (method: string, params: unknown) => void,
  ): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  /**
   * Subscribe to server requests (messages with both `method` and `id`).
   *
   * These are approval / HITL requests. The handler must eventually call
   * {@link respondToServerRequest} or {@link respondToServerRequestError}
   * with the same `id`.
   *
   * @returns an unsubscribe function.
   */
  onServerRequest(
    handler: (method: string, id: RequestId, params: unknown) => void,
  ): () => void {
    this.serverRequestHandlers.add(handler);
    return () => this.serverRequestHandlers.delete(handler);
  }

  /**
   * Subscribe to transport close events.
   * @returns an unsubscribe function.
   */
  onClose(handler: () => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  /**
   * Shut down the client: reject all pending requests, mark as closed.
   * Idempotent.
   */
  close(): void {
    if (this.state === "closed") return;
    this.state = "closing";
    this.rejectAllPending(new Error("Client closed"));
    this.state = "closed";
    this.fireCloseHandlers();
  }

  // ── Internal: state guard ─────────────────────────────────────────────────

  private requireReady(method: string): void {
    if (this.state !== "ready") {
      throw new Error(
        `Method "${method}" requires state "ready", current state: "${this.state}"`,
      );
    }
  }

  // ── Internal: sending ─────────────────────────────────────────────────────

  /**
   * Core request method (no state guard — used internally by `initialize`).
   */
  private doRequest(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    const message = JSON.stringify({ method, id, params });

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(
            new Error(
              `Request "${method}" (id=${id}) timed out after ${this.requestTimeoutMs}ms`,
            ),
          );
        }
      }, this.requestTimeoutMs);
      timer.unref?.();

      this.pending.set(id, { resolve, reject, timer });
      this.transport.send(message + "\n");
      this.emitTrace("client_to_server", "request", method, id, params);
    });
  }

  /** Core notify method (no state guard — used internally by `initialize`). */
  private doNotify(method: string, params?: unknown): void {
    const message = JSON.stringify({ method, params });
    this.transport.send(message + "\n");
    this.emitTrace("client_to_server", "notification", method, undefined, params);
  }

  // ── Internal: receiving ───────────────────────────────────────────────────

  /**
   * Handle a single newline-delimited line from the server's stdout.
   *
   * Dispatches to the correct handler based on message shape:
   * - Has `id` + no `method` → response to our request
   * - Has `method` + `id` → server request (approval)
   * - Has `method` + no `id` → notification
   */
  private handleLine(line: string): void {
    if (line.length > MAX_LINE_LENGTH) {
      this.parseErrorCount++;
      this.emitTrace("server_to_client", "notification", "protocol_warning", undefined, {
        reason: "line_too_long",
        length: line.length,
      });
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Non-JSON line — record and continue, do not crash the reader (§8)
      this.parseErrorCount++;
      return;
    }

    if (typeof parsed !== "object" || parsed === null) {
      this.parseErrorCount++;
      return;
    }

    const msg = parsed as Record<string, unknown>;
    const hasId = "id" in msg && msg.id != null;
    const hasMethod = "method" in msg && typeof msg.method === "string";

    // Server response: has id, no method → matches our pending request
    if (hasId && !hasMethod) {
      this.handleResponse(msg as unknown as JsonRpcResponse);
      return;
    }

    // Server request: has both method and id → approval / HITL
    if (hasMethod && hasId) {
      const serverReq = msg as unknown as JsonRpcServerRequest;
      this.emitTrace(
        "server_to_client",
        "server_request",
        serverReq.method,
        serverReq.id,
        serverReq.params,
      );
      for (const handler of this.serverRequestHandlers) {
        try {
          handler(serverReq.method, serverReq.id, serverReq.params);
        } catch {
          // A handler error must not break line reading.
        }
      }
      return;
    }

    // Notification: has method, no id
    if (hasMethod) {
      const method = msg.method as string;
      const params = msg.params;
      this.emitTrace("server_to_client", "notification", method, undefined, params);
      for (const handler of this.notificationHandlers) {
        try {
          handler(method, params);
        } catch {
          // A handler error must not break line reading.
        }
      }
      return;
    }

    // Unknown message shape
    this.parseErrorCount++;
  }

  /** Match a server response to a pending request and resolve/reject it. */
  private handleResponse(response: JsonRpcResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) {
      // Response for an unknown or already-timed-out request — ignore.
      return;
    }

    this.pending.delete(response.id);
    clearTimeout(pending.timer);

    if (response.error) {
      this.emitTrace("server_to_client", "response", undefined, response.id, {
        error: response.error,
      });
      pending.reject(
        new Error(
          `JSON-RPC error ${response.error.code}: ${response.error.message}`,
        ),
      );
    } else {
      this.emitTrace(
        "server_to_client",
        "response",
        undefined,
        response.id,
        response.result,
      );
      pending.resolve(response.result);
    }
  }

  // ── Internal: close / cleanup ─────────────────────────────────────────────

  /** Called when the transport (process) exits unexpectedly. */
  private handleTransportClose(): void {
    this.rejectAllPending(new Error("Process exited"));
    if (this.state !== "closed") {
      this.state = "closed";
      this.fireCloseHandlers();
    }
  }

  /** Reject every pending request with the given error. */
  private rejectAllPending(error: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private fireCloseHandlers(): void {
    for (const handler of this.closeHandlers) {
      try {
        handler();
      } catch {
        // A handler error must not break cleanup.
      }
    }
  }

  // ── Internal: trace ───────────────────────────────────────────────────────

  private emitTrace(
    direction: "client_to_server" | "server_to_client",
    kind: "request" | "response" | "notification" | "server_request",
    method: string | undefined,
    id: RequestId | undefined,
    payload: unknown,
  ): void {
    if (!this.trace) return;
    try {
      const entry: CodexAppServerTrace = {
        timestamp: Date.now(),
        direction,
        kind,
        ...(method !== undefined ? { method } : {}),
        ...(id !== undefined ? { id } : {}),
        payload,
      };
      this.trace(entry);
    } catch {
      // Trace must never affect the protocol.
    }
  }
}
