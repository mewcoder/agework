/**
 * Internal types for the Codex app-server JSON-RPC client.
 *
 * This module is framework-agnostic (no @nestjs/*). It defines the transport
 * abstraction, JSON-RPC message primitives, the client state machine, and the
 * raw trace interface.
 *
 * Protocol field shapes are confirmed against `codex app-server generate-ts`
 * output (0.144.1) and docs/codex-app-server.md.
 */

// ── JSON-RPC primitives ─────────────────────────────────────────────────────

/**
 * JSON-RPC request id.
 *
 * We always send monotonically increasing **numbers**. The server may use
 * **strings** for server-initiated requests. Both are handled.
 *
 * Matches the generated `RequestId = string | number`.
 */
export type RequestId = number | string;

/** A JSON-RPC request (client → server). */
export type JsonRpcRequest = {
  method: string;
  id: RequestId;
  params?: unknown;
};

/** A JSON-RPC notification (either direction, no id, no response). */
export type JsonRpcNotification = {
  method: string;
  params?: unknown;
};

/** A JSON-RPC error object. */
export type JsonRpcError = {
  code: number;
  message: string;
  data?: unknown;
};

/** A JSON-RPC response (server → client, matching a request id). */
export type JsonRpcResponse = {
  id: RequestId;
  result?: unknown;
  error?: JsonRpcError;
};

/**
 * A JSON-RPC request initiated by the **server** (server → client).
 *
 * Has both `method` and `id` — the client must respond with `{ id, result }`
 * or `{ id, error }`. This is the approval / HITL channel.
 */
export type JsonRpcServerRequest = {
  method: string;
  id: RequestId;
  params?: unknown;
};

// ── Client state machine (§8) ───────────────────────────────────────────────

/**
 * Client lifecycle states.
 *
 * Transitions:
 * ```
 * created → initialize_sent → initialize_resolved → initialized_sent → ready → closing → closed
 * ```
 *
 * Only `ready` allows Thread/Turn methods. `initialize()` is the only method
 * allowed in `created` state.
 */
export type CodexAppServerClientState =
  | "created"
  | "initialize_sent"
  | "initialize_resolved"
  | "initialized_sent"
  | "ready"
  | "closing"
  | "closed";

// ── Transport abstraction ───────────────────────────────────────────────────

/**
 * Abstraction over the process stdio, enabling the JSON-RPC client to be
 * tested without spawning a real `codex app-server` subprocess.
 *
 * - `send` writes a raw string (one complete JSON-RPC message, newline
 *   already appended by the caller) to the server's stdin.
 * - `onMessage` registers a handler for each newline-delimited line from
 *   the server's stdout.
 * - `onClose` registers a handler for when the transport (process) exits.
 */
export type AppServerTransport = {
  /** Write a raw string to the server's stdin (newline already included). */
  send(message: string): void;
  /** Register a handler for each line received from the server's stdout. */
  onMessage(handler: (line: string) => void): void;
  /** Register a handler for when the transport exits unexpectedly. */
  onClose(handler: () => void): void;
};

// ── Raw trace (§15) ─────────────────────────────────────────────────────────

/** Direction of a trace entry. */
export type TraceDirection = "client_to_server" | "server_to_client";

/** Kind of JSON-RPC message. */
export type TraceKind =
  | "request"
  | "response"
  | "notification"
  | "server_request";

/**
 * A single raw protocol trace entry (§15).
 *
 * Every JSON-RPC message sent or received is traced through this structure.
 * The adapter bridges this to the existing `AgentTraceSink` → `sdk.raw` JSONL
 * pipeline.
 */
export type CodexAppServerTrace = {
  timestamp: number;
  direction: TraceDirection;
  kind: TraceKind;
  method?: string;
  id?: RequestId;
  payload: unknown;
};

/** Callback for raw protocol tracing. */
export type CodexAppServerTraceSink = (trace: CodexAppServerTrace) => void;

// ── Error classification (§14) ──────────────────────────────────────────────

/** Structured error kinds for the app-server client. */
export type CodexAppServerErrorKind =
  | "spawn_failed"
  | "initialize_failed"
  | "protocol_parse_failed"
  | "request_timeout"
  | "request_rejected"
  | "process_exited"
  | "thread_not_found"
  | "turn_failed"
  | "turn_interrupted"
  | "unsupported_method"
  | "version_mismatch";

// ── Version gate (§9, 决策1) ────────────────────────────────────────────────

/**
 * Result of comparing the runtime codex version with the generated schema
 * version (【决策1】).
 *
 * - `compatible` — exact match or known-compatible version.
 * - `degraded` — minor drift; capability table applies degradation.
 * - `incompatible` — major drift or unknown; `RUN_ERROR(version_mismatch)`.
 */
export type VersionGateResult =
  | { status: "compatible"; codexVersion: string }
  | { status: "degraded"; codexVersion: string; reason: string }
  | { status: "incompatible"; codexVersion: string; reason: string };

/**
 * Configuration for the version gate. When `strict` is true (default for
 * Managed runtime), an incompatible version throws. When false (Registered /
 * user-supplied codex), the gate is best-effort and never blocks.
 */
export type VersionGateConfig = {
  /** The generated schema version (from `version.ts`). */
  generatedVersion: string;
  /** When true, incompatible versions cause `initialize` to throw. Default: true. */
  strict?: boolean;
};

// ── Internal ────────────────────────────────────────────────────────────────

/** Internal: a pending JSON-RPC request awaiting response. */
export type PendingRequest = {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};
