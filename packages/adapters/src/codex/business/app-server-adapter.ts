/**
 * Codex app-server AG-UI adapter.
 *
 * This is the "real runner" that connects the app-server JSON-RPC client
 * to the AG-UI event stream. One adapter instance owns one app-server
 * subprocess (per ADR-0001 decision 2: "一个 Codex Runner 一个 app-server 子进程").
 *
 * Lifecycle:
 * 1. `run(input)` spawns a `CodexAppServerProcess`, initializes the client,
 *    starts/resumes a thread, starts a turn, and translates notifications
 *    into AG-UI events via `AppServerEventTranslator`.
 * 2. When the app-server sends an approval server-request, the adapter
 *    emits `RUN_FINISHED{interrupt}` (terminal model) and waits for the
 *    user to respond via `resolveApproval`. The app-server turn is still
 *    alive — the adapter holds the pending rpcId.
 * 3. On `turn/completed` (terminal), the translator emits RUN_FINISHED/RUN_ERROR
 *    and the adapter terminates the subprocess.
 * 4. `interrupt(threadId?)` sends `turn/interrupt` then terminates the process.
 * 5. On unexpected process exit, `translateProcessExit` produces RUN_ERROR.
 *
 * The adapter extends `AbstractAgent` so it is a drop-in replacement for the
 * SDK-based `CodexAgentAdapter` in the worker's `createAgentDriver`.
 */

import { Observable, type Subscriber } from "rxjs";
import { AbstractAgent, EventType } from "@ag-ui/client";
import type { BaseEvent, RunAgentInput } from "@ag-ui/core";
import { generateId } from "@agework/shared";
import type { AgentTraceSink } from "@agework/shared/protocol";
import { Logger } from "@nestjs/common";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CodexAppServerProcess } from "./codex-app-server-process";
import {
  CodexAppServerClient,
  type ThreadResponse,
  type TurnStartParams,
  type ThreadStartParams,
  type ThreadResumeParams,
} from "../base/app-server/client";
import type { UserInput } from "../base/app-server/generated/v2/UserInput";
import type { SandboxPolicy } from "../base/app-server/generated/v2/SandboxPolicy";
import type { SandboxMode } from "../base/app-server/generated/v2/SandboxMode";
import type { AskForApproval } from "../base/app-server/generated/v2/AskForApproval";
import type { ApprovalsReviewer } from "../base/app-server/generated/v2/ApprovalsReviewer";
import {
  AppServerEventTranslator,
  type TranslatorContext,
} from "../base/app-server/translator";
import type { CodexAppServerTraceSink } from "../base/app-server/types";
import {
  ApprovalBridge,
  classifyApprovalMethod,
  type ApprovalInterruptInfo,
  type PendingCodexRequest,
} from "../base/app-server/approval-bridge";
import {
  processMessages,
  buildStateContextAddendum,
  hasState,
} from "../base/utils";
import { pickSafeEnv } from "../../common/safe-env";

const logger = new Logger("CodexAppServerAdapter");

const PROVIDER_NAME = "_agework";

/**
 * Schema base decision set for command/file approvals — the string variants
 * of the generated `CommandExecutionApprovalDecision` / `FileChangeApprovalDecision`.
 * Object variants (execpolicy / network-policy amendments) are only allowed
 * when the server explicitly listed them in `availableDecisions`.
 */
const BASE_APPROVAL_DECISIONS = [
  "accept",
  "acceptForSession",
  "decline",
  "cancel",
] as const;

// ── Env-driven config (§12 of migration doc) ────────────────────────────────

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;

/** Parse a positive integer from an env var, falling back to `fallback`. */
function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveRequestTimeoutMs(): number {
  return envInt("AGEWORK_CODEX_APP_SERVER_REQUEST_TIMEOUT_MS", DEFAULT_REQUEST_TIMEOUT_MS);
}

function resolveShutdownTimeoutMs(): number {
  return envInt("AGEWORK_CODEX_APP_SERVER_SHUTDOWN_TIMEOUT_MS", DEFAULT_SHUTDOWN_TIMEOUT_MS);
}

// ── Orphan prevention: module-level exit handler (§7) ───────────────────────
//
// A single `process.on('exit')` handler iterates all live adapter instances
// and forceKills their subprocesses. This avoids one listener per adapter
// (which triggers MaxListenersExceededWarning in tests) and ensures cleanup
// even on abrupt `process.exit()`.

const liveAdapters = new Set<CodexAppServerAgentAdapter>();
let exitHandlerRegistered = false;

function ensureExitHandler(): void {
  if (exitHandlerRegistered) return;
  exitHandlerRegistered = true;
  process.on("exit", () => {
    for (const adapter of liveAdapters) {
      adapter.forceKillAll();
    }
  });
}

// ── Pending action sink (shared with Claude adapter pattern) ────────────────

export type AgentPendingAction = "question" | null;
export type AgentPendingActionSink = (event: {
  threadId: string;
  pendingAction: AgentPendingAction;
}) => void | Promise<void>;

// ── Config ──────────────────────────────────────────────────────────────────

export type CodexAppServerAdapterConfig = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  cwd?: string;
  modelReasoningEffort?: "low" | "medium" | "high" | "xhigh";
  trace?: AgentTraceSink;
  /** Path to the codex CLI binary (already resolved by worker). */
  codexPath?: string;
  /** Direct --config overrides for the codex CLI. */
  extraConfig?: Record<string, unknown>;
  /**
   * Inject a pre-built client (for testing). When provided, `codexPath` is
   * ignored and no subprocess is spawned.
   */
  client?: CodexAppServerClient;
  /** Inject a pre-built process (for testing). When provided, `codexPath` is ignored. */
  process?: CodexAppServerProcess;
  /** Notifies the worker when a pending action is set/cleared (HITL). */
  pendingActionSink?: AgentPendingActionSink;
};

// ── Internal types ──────────────────────────────────────────────────────────

/** Per-run state tracked for interrupt, cleanup, and approval resolution. */
type ActiveRun = {
  threadId: string;
  runId: string;
  codexThreadId: string | null;
  turnId: string | null;
  translator: AppServerEventTranslator;
  client: CodexAppServerClient;
  proc: CodexAppServerProcess | null;
  subscriber: Subscriber<BaseEvent>;
  abortController: AbortController;
  terminated: boolean;
  /** The approval bridge for this run. */
  approvalBridge: ApprovalBridge;
  /**
   * The translator context shared with the drain loop. `resolveApproval`
   * mutates `ctx.runId` to the resume runId so continuation events after an
   * approval belong to the new AG-UI run (§11.4 step 4 — same as the Claude
   * adapter's resumedRunIds behavior).
   */
  ctx: TranslatorContext;
};

// ── Adapter ─────────────────────────────────────────────────────────────────

export class CodexAppServerAgentAdapter extends AbstractAgent {
  private readonly config: CodexAppServerAdapterConfig;
  /** Maps AG-UI threadId → codex app-server threadId for multi-turn resume. */
  private readonly sessions = new Map<string, string>();
  /** Maps AG-UI threadId → active run state for interrupt. */
  private readonly activeRuns = new Map<string, ActiveRun>();
  /** Per-thread pending action updates (serialized to preserve order). */
  private readonly pendingActionUpdates = new Map<string, Promise<void>>();

  constructor(opts: CodexAppServerAdapterConfig = {}) {
    super();
    this.config = opts;
    // Register with the module-level orphan prevention handler (§7).
    liveAdapters.add(this);
    ensureExitHandler();
  }

  /**
   * Synchronously SIGKILL all spawned subprocesses.
   *
   * Called by the module-level `process.on('exit')` handler as last-resort
   * orphan prevention (§7 of migration doc): `forceExitAfterInterrupt` in
   * worker.ts calls `process.exit()` after an 8s grace. If
   * `adapter.interrupt()` hasn't finished by then (e.g. `turn/interrupt`
   * request hangs), the app-server subprocess would be orphaned.
   */
  forceKillAll(): void {
    for (const run of this.activeRuns.values()) {
      run.proc?.forceKill();
    }
  }

  public clone(): CodexAppServerAgentAdapter {
    const cloned = super.clone() as CodexAppServerAgentAdapter;
    (cloned as unknown as { config: CodexAppServerAdapterConfig }).config = {
      ...this.config,
    };
    return cloned;
  }

  // ── AbstractAgent implementation ──────────────────────────────────────────

  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      const threadId = input.threadId ?? "default";
      const runId = input.runId ?? generateId();

      this.executeRun(input, threadId, runId, subscriber).catch((error) => {
        subscriber.error(error);
      });
    });
  }

  /**
   * Interrupt the in-flight turn for the given thread (or all threads).
   *
   * Sends `turn/interrupt` to the app-server, then terminates the subprocess.
   * If the process is already gone, this is a no-op.
   */
  public async interrupt(threadId?: string): Promise<void> {
    if (threadId) {
      await this.interruptRun(threadId);
      return;
    }
    const promises: Promise<void>[] = [];
    for (const id of [...this.activeRuns.keys()]) {
      promises.push(this.interruptRun(id));
    }
    await Promise.all(promises);
  }

  /**
   * Resolve a pending approval (HITL response).
   *
   * Called by the worker driver when an `approval_resolved` command arrives.
   * The payload is provider-agnostic (【决策2】) — this method interprets it
   * for Codex:
   * - `{ decision: "accept" | "acceptForSession" | "decline" | "cancel" }`
   *   for command/file approvals
   * - `{ permissions: ..., scope: "turn"|"session" }` for permission approvals
   * - `{ status: "cancelled" }` when the user cancelled → decline/cancel
   *
   * @returns true if a pending approval was resolved, false otherwise.
   */
  public resolveApproval(
    threadId: string,
    payload: unknown,
    resumeRunId?: string,
  ): boolean {
    const run = this.activeRuns.get(threadId);
    if (!run) return false;

    const pending = run.approvalBridge.getPending(threadId);
    if (!pending) return false;

    // Emit RUN_STARTED for the resume run (terminal model continuation),
    // and switch the shared translator context to the resume runId so
    // continuation events belong to the new AG-UI run (§11.4 step 4).
    if (resumeRunId) {
      run.subscriber.next({
        type: EventType.RUN_STARTED,
        threadId,
        runId: resumeRunId,
      });
      run.ctx.runId = resumeRunId;
    }

    // Build and send the approval response
    const response = this.buildApprovalResponse(pending, payload);
    run.client.respondToServerRequest(pending.rpcId, response);

    // Mark resolved in the bridge (dequeues next if any)
    run.approvalBridge.markResolved(threadId);

    // Clear pending action
    this.emitPendingAction(threadId, null);

    logger.log(
      `approval resolved: thread=${threadId}, method=${pending.method}, ` +
        `interruptId=${pending.interruptId}`,
    );

    return true;
  }

  // ── Core run logic ────────────────────────────────────────────────────────

  private async executeRun(
    input: RunAgentInput,
    threadId: string,
    runId: string,
    subscriber: Subscriber<BaseEvent>,
  ): Promise<void> {
    const abortController = new AbortController();
    const translator = new AppServerEventTranslator();
    const approvalBridge = new ApprovalBridge();

    let client: CodexAppServerClient;
    let proc: CodexAppServerProcess | null = null;

    // Track whether the subscriber has already been completed
    // (by the close handler or the normal flow).
    let completed = false;

    try {
      if (this.config.client) {
        client = this.config.client;
      } else {
        proc = this.config.process ?? this.spawnProcess();
        proc.start();

        client = new CodexAppServerClient(proc, {
          trace: this.createProtocolTrace(input),
          requestTimeoutMs: resolveRequestTimeoutMs(),
        });
      }

      // Shared with the drain loop; `resolveApproval` mutates `ctx.runId`
      // to the resume runId for post-approval continuation events.
      const ctx: TranslatorContext = { threadId, runId };

      const activeRun: ActiveRun = {
        threadId,
        runId,
        codexThreadId: null,
        turnId: null,
        translator,
        client,
        proc,
        subscriber,
        abortController,
        terminated: false,
        approvalBridge,
        ctx,
      };
      this.activeRuns.set(threadId, activeRun);

      // Listen for unexpected process exit
      if (proc) {
        proc.onClose(() => {
          if (activeRun.terminated || translator.terminal || completed) return;
          // Process died before turn/completed — emit RUN_ERROR
          const result = translator.translateProcessExit(ctx);
          for (const event of result.events) {
            subscriber.next(event as BaseEvent);
          }
          // Reject all pending approvals
          approvalBridge.rejectAll();
          completed = true;
          subscriber.complete();
        });
      }

      // ── 1. Initialize ────────────────────────────────────────────────────
      const initResult = await client.initialize({
        clientInfo: {
          name: "agework",
          title: "AgeWork",
          version: "1.0.0",
        },
      });

        logger.log(
          `app-server initialized: codex=${initResult.codexVersion ?? "(unknown)"}, ` +
            `gate=${initResult.versionGate.status}`,
        );

        if (initResult.versionGate.status !== "compatible" && initResult.versionGate.reason) {
          logger.warn(`version gate ${initResult.versionGate.status}: ${initResult.versionGate.reason}`);
        }

      // ── 2. Start or resume thread ────────────────────────────────────────
      const existingCodexThreadId = this.sessions.get(threadId);
      const threadParams = this.buildThreadParams(input);

      let threadResponse: ThreadResponse;
      if (existingCodexThreadId) {
        logger.log(`resuming thread ${existingCodexThreadId}`);
        const resumeParams: ThreadResumeParams = {
          threadId: existingCodexThreadId,
          ...threadParams,
        };
        threadResponse = await client.resumeThread(resumeParams);
      } else {
        logger.log("starting new thread");
        threadResponse = await client.startThread(threadParams);
      }

      const codexThreadId = threadResponse.thread.id;
      activeRun.codexThreadId = codexThreadId;
      this.sessions.set(threadId, codexThreadId);

      // ── 3. Emit RUN_STARTED ──────────────────────────────────────────────
      subscriber.next({
        type: EventType.RUN_STARTED,
        threadId,
        runId,
      });

      if (hasState(input.state)) {
        subscriber.next({
          type: EventType.STATE_SNAPSHOT,
          snapshot: input.state,
        });
      }

      // ── 4. Start turn ────────────────────────────────────────────────────
      const { userMessage } = processMessages(input);
      const turnParams = this.buildTurnParams(codexThreadId, userMessage, input);

      const turnResponse = await client.startTurn(turnParams);
      activeRun.turnId = turnResponse.turn.id;

      // ── 5. Subscribe to approval server-requests ─────────────────────────
      const unsubServerRequest = client.onServerRequest(
        async (method, rpcId, params) => {
          await this.handleApprovalRequest(
            method,
            rpcId,
            params,
            activeRun,
            ctx,
            subscriber,
          );
        },
      );

      // ── 6. Translate notifications until terminal ────────────────────────
      await this.drainNotifications(
        client,
        translator,
        ctx,
        subscriber,
        abortController.signal,
        approvalBridge,
      );

      unsubServerRequest();

      // ── 7. Finalize ──────────────────────────────────────────────────────
      if (!translator.terminal && !completed) {
        if (abortController.signal.aborted) {
          // User clicked stop — don't emit RUN_ERROR, just complete.
          // The interrupt flow already handled cleanup.
        } else {
          // Notification stream ended without turn/completed — treat as error
          const exitResult = translator.translateProcessExit(ctx);
          for (const event of exitResult.events) {
            subscriber.next(event as BaseEvent);
          }
        }
      }

      if (!completed) {
        completed = true;
        subscriber.complete();
      }
    } catch (error) {
      if (abortController.signal.aborted || completed) {
        if (!completed) {
          completed = true;
          subscriber.complete();
        }
        return;
      }

      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logger.error(`run failed: ${errorMessage}`);

      // Close any active translator events before emitting RUN_ERROR
      const ctx: TranslatorContext = { threadId, runId };
      const closeEvents = translator.closeActiveEvents(ctx);
      for (const event of closeEvents) {
        subscriber.next(event as BaseEvent);
      }

      if (!completed) {
        completed = true;
        subscriber.next({
          type: EventType.RUN_ERROR,
          threadId,
          runId,
          message: errorMessage,
        });
        subscriber.complete();
      }
    } finally {
      // Clean up approval bridge
      approvalBridge.rejectAll();

      // Terminate the subprocess (best-effort)
      const run = this.activeRuns.get(threadId);
      if (run) {
        run.terminated = true;
        if (run.proc) {
          await run.proc.terminate().catch(() => {});
        }
        this.activeRuns.delete(threadId);
      }
    }
  }

  // ── Approval handling ──────────────────────────────────────────────────────

  /**
   * Handle an incoming app-server approval request (§11.3).
   *
   * Registers the request in the bridge, emits RUN_FINISHED{interrupt} to
   * pause the AG-UI run, and sets pendingUserAction. The app-server turn
   * remains alive — the response will be sent when the user responds via
   * `resolveApproval`.
   */
  private async handleApprovalRequest(
    method: string,
    rpcId: number | string,
    params: unknown,
    run: ActiveRun,
    ctx: TranslatorContext,
    subscriber: Subscriber<BaseEvent>,
  ): Promise<void> {
    const kind = classifyApprovalMethod(method);
    if (!kind) {
      // Unknown server request method — respond with error
      logger.warn(`unknown server request method: ${method}`);
      run.client.respondToServerRequestError(rpcId, {
        code: -32601,
        message: `Method not supported: ${method}`,
      });
      return;
    }

    // Check idempotency — already resolved?
    if (run.approvalBridge.isResolved(rpcId)) {
      logger.warn(`server request ${rpcId} already resolved — ignoring`);
      return;
    }

    // Register in bridge (may queue if there's already a pending approval)
    // Pass the AG-UI threadId (run.threadId) as the map key — resolveApproval
    // and getPending look up by this same id, not the codex threadId in params.
    const interruptInfo = await run.approvalBridge.register(
      method,
      rpcId,
      params,
      run.threadId,
    );
    if (!interruptInfo) {
      logger.warn(`failed to register approval for method: ${method}`);
      return;
    }

    // If there was already a pending approval, this one is queued.
    // The interrupt will be emitted when the previous one is resolved
    // (via markResolved → dequeue). For now, check if this is the active one.
    const pending = run.approvalBridge.getPending(run.threadId);
    if (!pending || String(pending.rpcId) !== String(rpcId)) {
      // Queued — will be emitted when the current one is resolved
      return;
    }

    // Close active translator events before emitting RUN_FINISHED
    const closeEvents = run.translator.closeActiveEvents(ctx);
    for (const event of closeEvents) {
      subscriber.next(event as BaseEvent);
    }

    // Emit RUN_FINISHED{interrupt} — terminal model (§11.3)
    // Does NOT complete the observable, does NOT close the app-server,
    // does NOT respond to the rpc.
    subscriber.next({
      type: EventType.RUN_FINISHED,
      threadId: ctx.threadId,
      runId: ctx.runId,
      outcome: {
        type: "interrupt",
        interrupts: [this.toAgUiInterrupt(interruptInfo)],
      },
    });

    // Set pendingUserAction (§11.3, 【决策3】 — always "question")
    this.emitPendingAction(run.threadId, "question");

    logger.log(
      `approval request: thread=${run.threadId}, method=${method}, ` +
        `rpcId=${rpcId}, interruptId=${interruptInfo.interruptId}`,
    );
  }

  /**
   * Build the JSON-RPC response for an approval based on the user's payload.
   *
   * The payload format (【决策2】 generalized):
   * - Command/File: `{ decision: "accept"|"acceptForSession"|"decline"|"cancel" }`
   * - Permission: `{ permissions: GrantedPermissionProfile, scope: "turn"|"session" }`
   * - Cancelled: `{ status: "cancelled" }` → maps to "cancel" (command/file)
   *   or denied (permission)
   */
  private buildApprovalResponse(
    pending: PendingCodexRequest,
    payload: unknown,
  ): unknown {
    const p = payload as Record<string, unknown> | null;

    // Handle cancelled status
    if (p?.status === "cancelled") {
      const kind = classifyApprovalMethod(pending.method);
      if (kind === "permission") {
        // Permission can't "cancel" — deny by granting nothing
        return { permissions: {}, scope: "turn" };
      }
      return { decision: "cancel" };
    }

    // Direct decision (command/file) — validate against the allowed set
    // before sending (§11.4 step 2: 校验 decision 在 availableDecisions 内).
    if (p?.decision !== undefined) {
      if (!this.decisionAllowed(pending, p.decision)) {
        logger.warn(
          `decision ${JSON.stringify(p.decision)} not in allowed set for ` +
            `method=${pending.method} — declining`,
        );
        return { decision: "decline" };
      }
      return { decision: p.decision };
    }

    // Permission response
    if (p?.permissions !== undefined) {
      return {
        permissions: p.permissions,
        ...(p.scope ? { scope: p.scope } : { scope: "turn" }),
        ...(p.strictAutoReview !== undefined
          ? { strictAutoReview: p.strictAutoReview }
          : {}),
      };
    }

    // Fallback: decline/cancel
    logger.warn(
      `unrecognized approval payload for method=${pending.method}, ` +
        `defaulting to decline`,
    );
    return { decision: "decline" };
  }

  /**
   * Validate a user decision against the server-allowed set (§11.4 step 2).
   *
   * String decisions must be in `availableDecisions` when the server sent it,
   * otherwise in the schema base set. Object-variant decisions (execpolicy /
   * network-policy amendments) are only allowed when the server explicitly
   * listed the variant name in `availableDecisions`.
   */
  private decisionAllowed(
    pending: PendingCodexRequest,
    decision: unknown,
  ): boolean {
    const allowed: readonly string[] =
      pending.availableDecisions ?? BASE_APPROVAL_DECISIONS;
    if (typeof decision === "string") return allowed.includes(decision);
    if (decision && typeof decision === "object" && !Array.isArray(decision)) {
      const keys = Object.keys(decision as Record<string, unknown>);
      return (
        keys.length === 1 &&
        pending.availableDecisions !== undefined &&
        allowed.includes(keys[0])
      );
    }
    return false;
  }

  /**
   * Convert ApprovalInterruptInfo to AG-UI interrupt format.
   */
  private toAgUiInterrupt(info: ApprovalInterruptInfo): Record<string, unknown> {
    const interrupt: Record<string, unknown> = {
      id: info.interruptId,
      reason: info.reason,
    };
    if (info.message) interrupt.message = info.message;
    if (info.toolCallId) interrupt.toolCallId = info.toolCallId;
    if (info.metadata) interrupt.metadata = info.metadata;
    return interrupt;
  }

  // ── Notification draining ─────────────────────────────────────────────────

  /**
   * Listen for notifications from the app-server and translate them into
   * AG-UI events. Resolves when the translator hits a terminal state, the
   * transport closes, or the abort signal fires.
   *
   * Also handles `serverRequest/resolved` notifications for idempotency
   * (§11.5) — clears the approval bridge's pending state.
   */
  private drainNotifications(
    client: CodexAppServerClient,
    translator: AppServerEventTranslator,
    ctx: TranslatorContext,
    subscriber: Subscriber<BaseEvent>,
    signal: AbortSignal,
    approvalBridge: ApprovalBridge,
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      let resolved = false;

      const cleanup = () => {
        unsubNotif();
        unsubClose();
      };

      const finish = () => {
        if (resolved) return;
        resolved = true;
        cleanup();
        resolve();
      };

      const unsubNotif = client.onNotification((method, params) => {
        if (resolved) return;

        // Handle serverRequest/resolved for idempotency (§11.5)
        if (method === "serverRequest/resolved") {
          const p = params as Record<string, unknown> | undefined;
          const requestId = p?.requestId as number | string | undefined;
          if (requestId !== undefined) {
            approvalBridge.clearByRequestId(requestId);
          }
          return;
        }

        const result = translator.translate(method, params, ctx);

        for (const event of result.events) {
          subscriber.next(event as BaseEvent);
        }

        if (result.terminal) {
          finish();
        }
      });

      const unsubClose = client.onClose(() => {
        if (!resolved && !translator.terminal) {
          finish();
        }
      });

      signal.addEventListener("abort", () => finish(), { once: true });
    });
  }

  // ── Pending action ─────────────────────────────────────────────────────────

  private emitPendingAction(
    threadId: string,
    pendingAction: AgentPendingAction,
  ): void {
    if (!this.config.pendingActionSink) return;

    const previous =
      this.pendingActionUpdates.get(threadId) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(() =>
        Promise.resolve(
          this.config.pendingActionSink?.({ threadId, pendingAction }),
        ),
      )
      .catch((error) => {
        logger.warn(`pending action update failed: ${String(error)}`);
      })
      .finally(() => {
        if (this.pendingActionUpdates.get(threadId) === next) {
          this.pendingActionUpdates.delete(threadId);
        }
      });
    this.pendingActionUpdates.set(threadId, next);
  }

  // ── Interrupt ─────────────────────────────────────────────────────────────

  private async interruptRun(threadId: string): Promise<void> {
    const run = this.activeRuns.get(threadId);
    if (!run) return;

    // If there's a pending approval, try to cancel it first (§11.5 step 1)
    const pending = run.approvalBridge.getPending(threadId);
    if (pending && !run.approvalBridge.isResolved(pending.rpcId)) {
      // Send cancel response if the approval method supports it
      try {
        const kind = classifyApprovalMethod(pending.method);
        if (kind === "command" || kind === "file") {
          run.client.respondToServerRequest(pending.rpcId, {
            decision: "cancel",
          });
        } else if (kind === "permission") {
          run.client.respondToServerRequest(pending.rpcId, {
            permissions: {},
            scope: "turn",
          });
        }
        run.approvalBridge.markResolved(threadId);
      } catch {
        // Best-effort — the process will be terminated anyway
      }
      // The AG-UI stream already ended with RUN_FINISHED{interrupt} when the
      // approval was raised — suppress further translator output so the
      // trailing turn/completed(interrupted) doesn't emit a second terminal
      // into the same stream. Turn tracking continues for the wait below.
      run.translator.suppressOutput();
    }

    // Graceful stop (§7 取消 / §11.5 step 2-3): send turn/interrupt, then
    // WAIT for turn/completed(interrupted) so the translator can emit the
    // interrupted terminal — do not kill the process out from under it.
    // The drain loop is still running at this point (we haven't aborted yet).
    if (run.turnId && run.codexThreadId && !run.terminated) {
      try {
        if (!run.translator.terminal) {
          await run.client.interruptTurn({
            threadId: run.codexThreadId,
            turnId: run.turnId,
          });
          await this.waitForTerminal(run, resolveShutdownTimeoutMs());
        }
      } catch {
        // Best-effort — fall through to forced cleanup
      }
    }

    // Release the drain loop and clean up (forced path if the terminal
    // never arrived within the grace period).
    run.abortController.abort();
    run.terminated = true;
    run.approvalBridge.clearThread(threadId);
    if (run.proc) {
      await run.proc.terminate().catch(() => {});
    }
    this.activeRuns.delete(threadId);
  }

  /**
   * Poll until the run's translator reaches a terminal state (turn/completed
   * arrived) or the grace period elapses. Returns whether terminal was reached.
   */
  private async waitForTerminal(
    run: ActiveRun,
    graceMs: number,
  ): Promise<boolean> {
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline) {
      if (run.translator.terminal) return true;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return run.translator.terminal;
  }

  // ── Process spawning ──────────────────────────────────────────────────────

  private spawnProcess(): CodexAppServerProcess {
    const codexPath = this.config.codexPath;
    if (!codexPath) {
      throw new Error(
        "CodexAppServerAgentAdapter requires codexPath (codex CLI binary not found)",
      );
    }

    const cwd = this.config.cwd ?? process.cwd();
    const env = this.buildProcessEnv();

    return new CodexAppServerProcess({
      codexPath,
      cwd,
      env,
      killGraceMs: resolveShutdownTimeoutMs(),
      onStderr: (line) => {
        logger.verbose(`[codex stderr] ${line}`);
      },
    });
  }

  private buildProcessEnv(): Record<string, string> {
    const safeEnv = pickSafeEnv({ includeClaudeEnv: false });
    const npmCacheDir = join(tmpdir(), "npm-cache-agent-runtime");
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(safeEnv)) {
      if (value !== undefined) env[key] = value;
    }
    env.NPM_CONFIG_CACHE = npmCacheDir;
    if (this.config.apiKey) {
      env.OPENAI_API_KEY = this.config.apiKey;
    }
    return env;
  }

  // ── Thread / Turn params ──────────────────────────────────────────────────

  /**
   * Extract permission settings from RunAgentInput.forwardedProps.
   *
   * The frontend (`agent-run-interceptor.ts`) translates the user-selected
   * `codexPermissionMode` into concrete app-server params:
   * - `sandboxMode`: SandboxMode string ("read-only" | "workspace-write" | "danger-full-access")
   * - `approvalPolicy`: AskForApproval string ("never" | "on-request" | "untrusted")
   * - `approvalsReviewer`: ApprovalsReviewer string ("user" | "auto_review")
   * - `networkAccessEnabled`: boolean
   */
  private extractPermissionProps(
    input: RunAgentInput,
  ): {
    sandboxMode?: SandboxMode;
    approvalPolicy?: AskForApproval;
    approvalsReviewer?: ApprovalsReviewer;
    networkAccessEnabled?: boolean;
  } {
    const fp = (input.forwardedProps ?? {}) as Record<string, unknown>;
    const sandboxMode = fp.sandboxMode as SandboxMode | undefined;
    const approvalPolicy = fp.approvalPolicy as AskForApproval | undefined;
    const approvalsReviewer = fp.approvalsReviewer as ApprovalsReviewer | undefined;
    const networkAccessEnabled =
      typeof fp.networkAccessEnabled === "boolean"
        ? fp.networkAccessEnabled
        : undefined;
    return { sandboxMode, approvalPolicy, approvalsReviewer, networkAccessEnabled };
  }

  private buildThreadParams(input: RunAgentInput): Omit<ThreadStartParams, never> {
    const providerConfig = this.buildProviderConfig();
    const extraConfig = this.config.extraConfig;
    const config =
      providerConfig || extraConfig
        ? { ...providerConfig, ...extraConfig }
        : undefined;

    const addendum = buildStateContextAddendum(input);
    const perms = this.extractPermissionProps(input);

    return {
      ...(this.config.model ? { model: this.config.model } : {}),
      cwd: this.config.cwd,
      approvalPolicy: perms.approvalPolicy ?? "untrusted",
      // thread/start uses SandboxMode (string enum), NOT SandboxPolicy (object).
      // The complex SandboxPolicy is only for turn/start's sandboxPolicy field.
      sandbox: perms.sandboxMode ?? "workspace-write",
      ...(perms.approvalsReviewer
        ? { approvalsReviewer: perms.approvalsReviewer }
        : {}),
      ...(config ? { config } : {}),
      ...(addendum ? { baseInstructions: addendum } : {}),
    };
  }

  private buildTurnParams(
    codexThreadId: string,
    userMessage: string,
    input: RunAgentInput,
  ): TurnStartParams {
    const userInput: UserInput = {
      type: "text",
      text: userMessage,
      text_elements: [],
    };
    const perms = this.extractPermissionProps(input);
    return {
      threadId: codexThreadId,
      input: [userInput],
      cwd: this.config.cwd,
      approvalPolicy: perms.approvalPolicy ?? "untrusted",
      sandboxPolicy: this.buildSandboxPolicy(
        this.config.cwd,
        perms.sandboxMode,
        perms.networkAccessEnabled,
      ),
      ...(perms.approvalsReviewer
        ? { approvalsReviewer: perms.approvalsReviewer }
        : {}),
      // Request reasoning summaries from the app-server.
      // "detailed" produces richer summary text than "auto" (the default).
      // Note: Codex app-server does NOT stream raw reasoning text
      // (item/reasoning/textDelta) — the `content` field is always empty.
      // The `summary` field is the only source of reasoning visibility.
      summary: "detailed",
      ...(this.config.model ? { model: this.config.model } : {}),
      ...(this.config.modelReasoningEffort
        ? { effort: this.config.modelReasoningEffort }
        : {}),
    };
  }

  /**
   * Build a SandboxPolicy for turn/start based on the user-selected sandbox mode.
   *
   * - `danger-full-access` → `{ type: "dangerFullAccess" }`
   * - `read-only`          → `{ type: "readOnly", networkAccess }`
   * - `workspace-write` (default) → `{ type: "workspaceWrite", ... }`
   */
  private buildSandboxPolicy(
    cwd?: string,
    sandboxMode?: SandboxMode,
    networkAccessEnabled?: boolean,
  ): SandboxPolicy {
    const networkAccess = networkAccessEnabled ?? false;

    if (sandboxMode === "danger-full-access") {
      return { type: "dangerFullAccess" };
    }

    if (sandboxMode === "read-only") {
      return { type: "readOnly", networkAccess };
    }

    // Default: workspace-write
    return {
      type: "workspaceWrite",
      writableRoots: cwd ? [cwd] : [],
      networkAccess,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    };
  }

  private buildProviderConfig(): Record<string, unknown> | undefined {
    const baseUrl = this.config.baseUrl
      ?.replace(/\/$/, "")
      .replace(/\/v1$/, "");
    if (!baseUrl) return undefined;

    return {
      model_provider: PROVIDER_NAME,
      model_providers: {
        [PROVIDER_NAME]: {
          name: "OpenAI",
          base_url: baseUrl,
          wire_api: "responses",
          requires_openai_auth: true,
        },
      },
    };
  }

  // ── Protocol trace ────────────────────────────────────────────────────────

  private createProtocolTrace(
    input: RunAgentInput,
  ): CodexAppServerTraceSink | undefined {
    if (!this.config.trace) return undefined;

    const trace = this.config.trace;
    const threadId = input.threadId ?? "default";

    return (entry) => {
      try {
        trace({
          name: `codex.app-server.${entry.direction}.${entry.kind}`,
          payload: {
            method: entry.method,
            id: entry.id,
            data: entry.payload,
          },
          threadId,
        });
      } catch {
        // Tracing must never affect the agent stream
      }
    };
  }
}
