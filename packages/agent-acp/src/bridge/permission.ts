import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import { generateId } from "@agework/shared";
import { AcpError } from "../engine/errors";
import type {
  AcpInterrupt,
  AcpPermissionOption,
  PendingAcpPermission,
} from "./pending-controls";

export type AcpPermissionBridgeOptions = {
  threadId: string;
  /** Emit the terminal interrupt (adapter wraps it into RUN_FINISHED). */
  emitInterrupt: (interrupt: AcpInterrupt) => void;
  /** Emit the resume RUN_STARTED and record runId ownership (adapter-owned). */
  emitResumeStart?: (resumeRunId: string) => void;
  /** Notify pending action state (requires_action ↔ running). */
  emitPendingAction?: (pendingAction: "question" | null) => void;
  /** Permission wait timeout; omit for no timeout. */
  timeoutMs?: number;
};

/**
 * Bridges ACP `session/request_permission` to AgeWork's AG-UI terminal-interrupt
 * / resume model (mirrors the Claude adapter):
 *
 *  request handler Promise stays pending
 *   → emit RUN_FINISHED{interrupt} + pendingAction("question")
 *   → user answers via `approval_resolved` (carrying resumeRunId)
 *   → emit RUN_STARTED(resumeRunId) → resolve the request → agent continues
 *
 * Requests are serialized per thread so only one interrupt is ever open.
 */
export class AcpPermissionBridge {
  private pending?: PendingAcpPermission;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: AcpPermissionBridgeOptions) {}

  /** Install this as {@link AcpConnection.setPermissionHandler}. */
  readonly handle = (
    req: RequestPermissionRequest
  ): Promise<RequestPermissionResponse> => {
    const prev = this.queue;
    const current = prev.catch(() => {}).then(() => this.awaitDecision(req));
    this.queue = current.catch(() => {});
    return current;
  };

  /**
   * Resolve a pending permission from an `approval_resolved` command. Returns
   * true only if the answer was valid and applied.
   */
  resolveControl(input: {
    threadId: string;
    answers: unknown;
    resumeRunId?: string;
  }): boolean {
    const pending = this.pending;
    if (!pending || pending.threadId !== input.threadId) return false;

    const optionId = this.extractOptionId(input.answers, pending);
    if (optionId == null) {
      // Invalid choice: keep the interrupt open so the user can retry (doc §13.5).
      return false;
    }

    this.pending = undefined;
    if (input.resumeRunId) pending.onResume?.(input.resumeRunId);
    pending.resolve(optionId);
    return true;
  }

  /** Reject any open permission (stop / shutdown / process exit / cancel). */
  cancel(reason = "permission cancelled"): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    pending.reject(new AcpError("ACP_PERMISSION_INVALID", reason));
  }

  private awaitDecision(
    req: RequestPermissionRequest
  ): Promise<RequestPermissionResponse> {
    return new Promise<RequestPermissionResponse>((resolve, reject) => {
      const interruptId = generateId();
      const options: AcpPermissionOption[] = req.options.map((o) => ({
        optionId: o.optionId,
        name: o.name,
        ...(o.kind ? { kind: o.kind } : {}),
      }));
      const toolCallId = req.toolCall.toolCallId ?? undefined;

      let timer: NodeJS.Timeout | undefined;
      const settle = (fn: () => void) => {
        if (timer) clearTimeout(timer);
        this.opts.emitPendingAction?.(null);
        fn();
      };

      this.pending = {
        threadId: this.opts.threadId,
        sessionId: req.sessionId,
        interruptId,
        toolCallId,
        options,
        resolve: (optionId) =>
          settle(() => resolve({ outcome: { outcome: "selected", optionId } })),
        reject: (err) => settle(() => reject(err)),
        onResume: this.opts.emitResumeStart,
      };

      // Emit the interrupt first, then flip pending action — same ordering the
      // Claude adapter relies on so the server aggregator sees interrupts before
      // requires_action triggers a metadata-carrying save.
      this.opts.emitInterrupt({
        id: interruptId,
        reason: "approval_required",
        message: req.toolCall.title ?? "Agent requires permission",
        ...(toolCallId ? { toolCallId } : {}),
        metadata: {
          protocol: "acp",
          sessionId: req.sessionId,
          options,
          // 审批卡片要能说清「批准的是什么」:title 是 agent 的真实工具名
          // (kind=search / title=glob),rawInput 才带得出 pattern、command
          // 这类关键参数。只显 title 的话用户看不到具体操作对象。
          toolCall: {
            ...(req.toolCall.title ? { title: req.toolCall.title } : {}),
            ...(req.toolCall.kind ? { kind: req.toolCall.kind } : {}),
            ...(req.toolCall.rawInput !== undefined &&
            req.toolCall.rawInput !== null
              ? { rawInput: req.toolCall.rawInput }
              : {}),
          },
        },
      });
      this.opts.emitPendingAction?.("question");

      if (this.opts.timeoutMs != null) {
        timer = setTimeout(() => {
          if (this.pending?.interruptId === interruptId) {
            this.pending = undefined;
            this.opts.emitPendingAction?.(null);
            reject(
              new AcpError("ACP_PERMISSION_TIMEOUT", "permission request timed out")
            );
          }
        }, this.opts.timeoutMs);
        timer.unref?.();
      }
    });
  }

  /** Read an optionId from the answers payload and validate it against the offered options. */
  private extractOptionId(
    answers: unknown,
    pending: PendingAcpPermission
  ): string | null {
    if (answers == null || typeof answers !== "object") return null;
    const record = answers as Record<string, unknown>;
    const candidate =
      typeof record[pending.interruptId] === "string"
        ? (record[pending.interruptId] as string)
        : this.firstStringValue(record);
    if (candidate == null) return null;
    return pending.options.some((o) => o.optionId === candidate)
      ? candidate
      : null;
  }

  private firstStringValue(record: Record<string, unknown>): string | null {
    for (const value of Object.values(record)) {
      if (typeof value === "string") return value;
    }
    return null;
  }
}
