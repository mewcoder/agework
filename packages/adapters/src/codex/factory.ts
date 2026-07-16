/**
 * Codex adapter factory — selects between app-server and SDK backends.
 *
 * Backend selection (ADR-0001 decision 4 & 5):
 * - `AGEWORK_CODEX_BACKEND=app-server` (default) → `CodexAppServerAgentAdapter`
 * - `AGEWORK_CODEX_BACKEND=sdk` → existing SDK-based `CodexAgentAdapter`
 *
 * The upper layer (worker `createAgentDriver`) calls `createCodexAdapter(config)`
 * and gets back a `CodexAgentInstance` — it does not know which backend is in use.
 */

import type { AbstractAgent } from "@ag-ui/client";
import type { Observable } from "rxjs";
import type { AgentTraceSink } from "@agework/shared/protocol";

import { CodexAgentAdapter, type CodexAdapterConfig } from "./business/codex-agent.adapter";
import {
  CodexAppServerAgentAdapter,
  type CodexAppServerAdapterConfig,
  type AgentPendingActionSink,
} from "./business/app-server-adapter";

// ── Types ───────────────────────────────────────────────────────────────────

/**
 * Structural type that both Codex backends satisfy. Exported so consumers
 * (e.g. the worker) can type the adapter without depending on `@ag-ui/client`.
 *
 * `resolveApproval` is the HITL entry point — called when an `approval_resolved`
 * command arrives from the server. The adapter interprets the opaque payload
 * (【决策2】) and sends the appropriate JSON-RPC response to the app-server.
 */
export type CodexAgentInstance = AbstractAgent & {
  interrupt(threadId?: string): Promise<void>;
  /**
   * Resolve a pending approval. Returns true if a pending approval was found
   * and resolved, false otherwise.
   */
  resolveApproval(
    threadId: string,
    payload: unknown,
    resumeRunId?: string,
  ): boolean;
};

/** Shared config fields understood by both backends. */
export type CodexBackendConfig = {
  apiKey?: string;
  baseUrl?: string;
  /**
   * ModelProvider 的 API 协议格式;source=system(系统环境,无自定义 provider)时不存在。
   * `openai-compatible` → wire_api="chat" + env_key;否则 wire_api="responses" + requires_openai_auth。
   */
  apiFormat?: "openai-responses" | "openai-compatible";
  model?: string;
  cwd?: string;
  modelReasoningEffort?: "low" | "medium" | "high" | "xhigh";
  trace?: AgentTraceSink;
  /** Path to the codex CLI binary (resolved by worker). */
  codexPath?: string;
  /** Direct --config overrides. */
  extraConfig?: Record<string, unknown>;
  /** Notifies the worker when a pending action is set/cleared (HITL). */
  pendingActionSink?: AgentPendingActionSink;
};

export type CodexBackend = "app-server" | "sdk";

// ── Env resolution ──────────────────────────────────────────────────────────

/**
 * Resolve the Codex backend from the `AGEWORK_CODEX_BACKEND` env var.
 *
 * Default: `"app-server"` (per ADR-0001 decision 4 — app-server is the
 * default once the adapter is implemented). Set to `"sdk"` for the
 * legacy `@openai/codex-sdk` adapter.
 */
export function resolveCodexBackend(
  env: Record<string, string | undefined> = process.env,
): CodexBackend {
  const raw = env.AGEWORK_CODEX_BACKEND?.trim().toLowerCase();
  if (raw === "sdk") return "sdk";
  // Default: app-server
  return "app-server";
}

// ── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create a Codex adapter instance based on the configured backend.
 *
 * The returned `CodexAgentInstance` is a drop-in for either:
 * - `CodexAppServerAgentAdapter` (default) — uses `codex app-server` JSON-RPC
 * - `CodexAgentAdapter` (SDK fallback) — uses `@openai/codex-sdk`
 */
export function createCodexAdapter(
  config: CodexBackendConfig,
  backend?: CodexBackend,
): CodexAgentInstance {
  const resolved = backend ?? resolveCodexBackend();

  if (resolved === "sdk") {
    const sdkConfig: CodexAdapterConfig = {
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      apiFormat: config.apiFormat,
      model: config.model,
      cwd: config.cwd,
      modelReasoningEffort: config.modelReasoningEffort,
      trace: config.trace,
      extraConfig: config.extraConfig,
      ...(config.codexPath ? { codexPathOverride: config.codexPath } : {}),
    };
    return new CodexAgentAdapter(sdkConfig);
  }

  // app-server backend
  const appServerConfig: CodexAppServerAdapterConfig = {
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    apiFormat: config.apiFormat,
    model: config.model,
    cwd: config.cwd,
    modelReasoningEffort: config.modelReasoningEffort,
    trace: config.trace,
    codexPath: config.codexPath,
    extraConfig: config.extraConfig,
    ...(config.pendingActionSink ? { pendingActionSink: config.pendingActionSink } : {}),
  };
  return new CodexAppServerAgentAdapter(appServerConfig);
}
