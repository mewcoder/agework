/**
 * Approval Bridge — server request 收发 + pending 单槽 registry（§11, 【决策6】）.
 *
 * This module is framework-agnostic (no @nestjs/*). It manages the lifecycle
 * of app-server approval requests:
 *
 * 1. **Register**: When the app-server sends a server request (e.g.
 *    `item/commandExecution/requestApproval`), the bridge stores it as the
 *    single pending approval for that thread.
 * 2. **Interrupt**: The adapter emits `RUN_FINISHED{interrupt}` to pause the
 *    AG-UI run. The app-server turn is still alive — the bridge holds the
 *    `rpcId` so the response can be sent later.
 * 3. **Resolve**: When the user responds (via resume), the bridge provides
 *    the `rpcId` and method so the adapter can send the JSON-RPC response.
 * 4. **Cancel**: If the user cancels (or the run is stopped), the bridge
 *    provides a cancel/decline response.
 * 5. **Idempotency**: `serverRequest/resolved` notification clears the
 *    pending entry without sending a duplicate response.
 *
 * Single-slot per thread（【决策6】）: concurrent app-server approval requests
 * are serialized by a per-thread promise queue. Only one interrupt is open
 * at a time; the next is dequeued after the current is resolved.
 */

import { generateId } from "@agework/shared";
import type { RequestId } from "./types";

// ── Types ───────────────────────────────────────────────────────────────────

/**
 * A pending approval request from the app-server (§11.2).
 *
 * Lives in the runner process (adapter), not in the server.
 */
export type PendingCodexRequest = {
  /** JSON-RPC request id (for responding). */
  rpcId: RequestId;
  /** The server request method (e.g. `item/commandExecution/requestApproval`). */
  method: string;
  /** App-server threadId. */
  threadId: string;
  /** App-server turnId. */
  turnId: string;
  /** The item being approved (command execution, file change, etc.). */
  itemId: string;
  /** Command approval's zsh-exec-bridge routing disambiguation id. */
  approvalId?: string | null;
  /** When the request was received. */
  createdAt: number;
  /** The raw params from the server request. */
  request: unknown;
  /** The interrupt id for AG-UI (correlates with `resume[].interruptId`). */
  interruptId: string;
  /**
   * For command approvals: the decisions the server allows the UI to show.
   * The UI must NOT show options outside this list.
   */
  availableDecisions?: string[];
};

/**
 * Information about an approval interrupt, for emitting AG-UI events.
 */
export type ApprovalInterruptInfo = {
  interruptId: string;
  reason: string;
  message?: string;
  toolCallId?: string;
  metadata?: Record<string, unknown>;
};

/**
 * The response to send back to the app-server for an approval.
 *
 * Built by the adapter based on the user's payload and the approval method.
 */
export type ApprovalResponse = {
  rpcId: RequestId;
  result: unknown;
};

// ── Approval kind classification ────────────────────────────────────────────

export type ApprovalKind =
  | "command"
  | "file"
  | "permission";

/**
 * Schema base decision set for command approvals. Object variants are only
 * accepted when the app-server explicitly lists them in availableDecisions.
 */
export const BASE_COMMAND_APPROVAL_DECISIONS = [
  "accept",
  "acceptForSession",
  "decline",
  "cancel",
] as const;

/**
 * Classify a server request method into an approval kind.
 */
export function classifyApprovalMethod(method: string): ApprovalKind | null {
  if (method === "item/commandExecution/requestApproval") return "command";
  if (method === "item/fileChange/requestApproval") return "file";
  if (method === "item/permissions/requestApproval") return "permission";
  return null;
}

// ── Approval Bridge ─────────────────────────────────────────────────────────

/**
 * Per-thread single-slot approval registry with serialization queue.
 *
 * Threaded approvals are serialized: if a second request arrives while one
 * is pending, it is queued. The queue ensures only one interrupt is open
 * at a time (【决策6】).
 */
export class ApprovalBridge {
  /** Per-thread pending request (single slot). */
  private readonly pending = new Map<string, PendingCodexRequest>();
  /**
   * Per-thread queue of waiting registrations.
   * Each entry resolves when it's this request's turn to be the active pending.
   */
  private readonly queues = new Map<
    string,
    Array<{ request: PendingCodexRequest; resolve: () => void }>
  >();
  /** Resolved rpcIds (idempotency — don't respond twice). */
  private readonly resolvedRpcIds = new Set<string>();

  // ── Registration ───────────────────────────────────────────────────────

  /**
   * Register a new approval request from the app-server.
   *
   * If there is already a pending request for this thread, the new one is
   * queued (【决策6】 serialization). The returned promise resolves when this
   * request becomes the active pending.
   *
   * @param aguiThreadId  The AG-UI threadId (used as the pending-map key so
   *                       `resolveApproval` / `getPending` can look it up by
   *                       the same id the adapter exposes externally).
   * @returns The interrupt info to emit, or null if the request was queued
   *          (the adapter will be notified via `onDequeued` when it's ready).
   */
  async register(
    method: string,
    rpcId: RequestId,
    params: unknown,
    aguiThreadId: string,
  ): Promise<ApprovalInterruptInfo | null> {
    const kind = classifyApprovalMethod(method);
    if (!kind) return null;

    const p = params as Record<string, unknown> | undefined;
    if (!p) return null;

    const codexThreadId = p.threadId as string;
    const turnId = p.turnId as string;
    const itemId = p.itemId as string;
    if (!codexThreadId || !turnId || !itemId) return null;

    const request: PendingCodexRequest = {
      rpcId,
      method,
      threadId: codexThreadId,
      turnId,
      itemId,
      ...(p.approvalId !== undefined ? { approvalId: p.approvalId as string | null } : {}),
      createdAt: Date.now(),
      request: params,
      interruptId: generateId(),
      ...(kind === "command" ? { availableDecisions: this.extractAvailableDecisions(p) } : {}),
    };

    // If there's already a pending request for this thread, queue this one.
    if (this.pending.has(aguiThreadId)) {
      await new Promise<void>((resolve) => {
        let queue = this.queues.get(aguiThreadId);
        if (!queue) {
          queue = [];
          this.queues.set(aguiThreadId, queue);
        }
        queue.push({ request, resolve });
      });
    }

    // Now this request is the active pending.
    this.pending.set(aguiThreadId, request);
    return this.buildInterruptInfo(request, kind);
  }

  // ── Resolution ────────────────────────────────────────────────────────

  /**
   * Get the pending request for a thread (for the adapter to build a response).
   *
   * Returns null if there is no pending request for this thread.
   */
  getPending(threadId: string): PendingCodexRequest | null {
    return this.pending.get(threadId) ?? null;
  }

  /**
   * Mark a pending request as resolved (the adapter has sent the response).
   *
   * This clears the pending slot and dequeues the next queued request (if any).
   *
   * @returns The dequeued request that should now be registered, or null.
   */
  markResolved(threadId: string): PendingCodexRequest | null {
    const resolved = this.pending.get(threadId);
    if (!resolved) return null;

    this.pending.delete(threadId);
    this.resolvedRpcIds.add(String(resolved.rpcId));

    // Dequeue the next queued request
    const queue = this.queues.get(threadId);
    if (queue && queue.length > 0) {
      const next = queue.shift()!;
      if (queue.length === 0) {
        this.queues.delete(threadId);
      }
      // The next request becomes the active pending
      this.pending.set(threadId, next.request);
      // Resolve the promise so `register()` returns
      next.resolve();
      return next.request;
    }
    return null;
  }

  /**
   * Check if a rpcId has already been resolved (idempotency check).
   */
  isResolved(rpcId: RequestId): boolean {
    return this.resolvedRpcIds.has(String(rpcId));
  }

  /**
   * Clear a pending request by rpcId (idempotency from `serverRequest/resolved`).
   *
   * This does NOT send a response — it only clears the local pending state.
   * Called when the app-server notifies that a server request was resolved
   * (either by us or by turn start/complete/interrupt).
   */
  clearByRequestId(requestId: RequestId): void {
    const key = String(requestId);
    for (const [threadId, pending] of this.pending) {
      if (String(pending.rpcId) === key) {
        this.markResolved(threadId);
        return;
      }
    }
    // Even if not in pending, mark as resolved for idempotency
    this.resolvedRpcIds.add(key);
  }

  /**
   * Whether there is a pending approval for the given thread.
   */
  hasPending(threadId: string): boolean {
    return this.pending.has(threadId);
  }

  // ── Cleanup ───────────────────────────────────────────────────────────

  /**
   * Reject all pending requests (e.g. when the process exits).
   * Clears all state.
   */
  rejectAll(): void {
    this.pending.clear();
    this.queues.clear();
  }

  /**
   * Clear all state for a specific thread (e.g. when the run is interrupted).
   */
  clearThread(threadId: string): void {
    this.pending.delete(threadId);
    this.queues.delete(threadId);
  }

  // ── Internal helpers ──────────────────────────────────────────────────

  /**
   * Build the AG-UI interrupt info from a pending request.
   */
  private buildInterruptInfo(
    request: PendingCodexRequest,
    kind: ApprovalKind,
  ): ApprovalInterruptInfo {
    const params = request.request as Record<string, unknown>;
    const reason = kind === "permission" ? "confirmation" : "confirmation";
    const message = this.buildApprovalMessage(request, kind, params);
    const metadata = this.buildApprovalMetadata(request, kind, params);

    return {
      interruptId: request.interruptId,
      reason,
      ...(message ? { message } : {}),
      ...(request.itemId ? { toolCallId: request.itemId } : {}),
      metadata,
    };
  }

  private buildApprovalMessage(
    request: PendingCodexRequest,
    kind: ApprovalKind,
    params: Record<string, unknown>,
  ): string | undefined {
    switch (kind) {
      case "command": {
        const command = params.command as string | null;
        const cwd = params.cwd as string | null;
        if (command) {
          return cwd ? `Command: ${command} (in ${cwd})` : `Command: ${command}`;
        }
        const reason = params.reason as string | null;
        return reason ?? "Command approval required";
      }
      case "file": {
        const reason = params.reason as string | null;
        return reason ?? "File change approval required";
      }
      case "permission": {
        const reason = params.reason as string | null;
        return reason ?? "Permission approval required";
      }
    }
  }

  private buildApprovalMetadata(
    request: PendingCodexRequest,
    kind: ApprovalKind,
    params: Record<string, unknown>,
  ): Record<string, unknown> {
    const metadata: Record<string, unknown> = {
      kind,
      method: request.method,
      threadId: request.threadId,
      turnId: request.turnId,
      itemId: request.itemId,
    };

    if (kind === "command") {
      if (params.command) metadata.command = params.command;
      if (params.cwd) metadata.cwd = params.cwd;
      if (params.reason) metadata.reason = params.reason;
      if (params.networkApprovalContext) metadata.networkApprovalContext = params.networkApprovalContext;
      metadata.availableDecisions = request.availableDecisions ?? [
        ...BASE_COMMAND_APPROVAL_DECISIONS,
      ];
    } else if (kind === "file") {
      if (params.reason) metadata.reason = params.reason;
      if (params.grantRoot) metadata.grantRoot = params.grantRoot;
    } else if (kind === "permission") {
      if (params.reason) metadata.reason = params.reason;
      if (params.permissions) metadata.permissions = params.permissions;
      if (params.cwd) metadata.cwd = params.cwd;
    }

    return metadata;
  }

  /**
   * Extract the available decisions from command approval params.
   *
   * The app-server provides `availableDecisions` — the UI must only show
   * these options (§11.6).
   */
  private extractAvailableDecisions(
    params: Record<string, unknown>,
  ): string[] | undefined {
    // Only honour what the server actually sent (§11.6) — fabricating a
    // default list here would let the UI show options the server never
    // offered. When absent, the schema's base decision set applies
    // (validated in the adapter at response time).
    const raw = params.availableDecisions;
    if (Array.isArray(raw)) {
      return raw.filter((d): d is string => typeof d === "string");
    }
    return undefined;
  }
}
