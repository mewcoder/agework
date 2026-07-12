/**
 * App-server notification → AG-UI event translator (§10).
 *
 * This module is framework-agnostic. It takes raw JSON-RPC notification
 * `{ method, params }` from the app-server and produces typed AG-UI events.
 *
 * The translator is **stateful** per-turn: it tracks active text messages,
 * tool calls, and reasoning blocks to ensure Start/End pairing is correct.
 *
 * Terminal state rule (【决策5】):
 * - `error` notification **never** produces a terminal event. It only sets a
 *   failure candidate and writes to RawTrace.
 * - `turn/completed` is the **only** terminal authority:
 *   - status=completed → RUN_FINISHED
 *   - status=interrupted → RUN_FINISHED (interrupt outcome)
 *   - status=failed → RUN_ERROR (using turn.error)
 * - Process death without `turn/completed` → RUN_ERROR (failure candidate
 *   ?? "process_exited").
 * - Late error/warning after terminal is swallowed.
 */

import { EventType } from "@ag-ui/client";
import type { Message } from "@ag-ui/core";
import type { RunUsage } from "@agework/shared/protocol";

// ── Generated types ──────────────────────────────────────────────────────────

import type { ThreadItem } from "./generated/v2/ThreadItem";
import type { Turn } from "./generated/v2/Turn";
import type { TurnStatus } from "./generated/v2/TurnStatus";
import type { TurnError } from "./generated/v2/TurnError";
import type { MessagePhase } from "./generated/MessagePhase";

// ── Public types ─────────────────────────────────────────────────────────────

/** Context passed to every translation call. */
export type TranslatorContext = {
  /** AG-UI threadId (maps to app-server threadId). */
  threadId: string;
  /** AG-UI runId for the current run. */
  runId: string;
};

/**
 * A single AG-UI event produced by the translator.
 *
 * We use `Record<string, unknown>` rather than the precise AG-UI event types
 * to avoid a hard dependency on `@ag-ui/core` type imports at every emission
 * site. The runtime shapes are correct — they are verified by the AG-UI
 * verifier in tests and by the consumer (subscriber.next).
 */
export type TranslatedEvent = Record<string, unknown>;

/** The output of a single translation call. */
export type TranslationResult = {
  /** AG-UI events to emit (in order). */
  events: TranslatedEvent[];
  /**
   * Whether this notification produced a terminal event (RUN_FINISHED /
   * RUN_ERROR). After a terminal, the translator stops processing further
   * notifications.
   */
  terminal: boolean;
  /**
   * Whether this was an `error` notification (sets failure candidate but
   * does not produce a terminal event — 【决策5】).
   */
  errorCandidate: boolean;
};

// ── Internal state ───────────────────────────────────────────────────────────

/** Per-item state for agent message streaming. */
type TextState = {
  itemId: string;
  messageId: string;
  accumulated: string;
  ended: boolean;
};

/** Per-item state for tool-like items (commandExecution, fileChange, etc.). */
type ToolState = {
  itemId: string;
  toolCallId: string;
  argsSent: boolean;
  ended: boolean;
  /** Accumulated output deltas for command execution. */
  outputBuffer: string;
};

/** Per-item state for reasoning streaming. */
type ReasoningState = {
  itemId: string;
  messageId: string;
  /** Per-summaryIndex accumulated summary text (short titles). */
  summaries: Map<number, string>;
  /** Per-contentIndex accumulated raw reasoning text. */
  contentParts: Map<number, string>;
  /** Whether REASONING_START has been emitted. */
  started: boolean;
  ended: boolean;
};

// ── Translator class ─────────────────────────────────────────────────────────

/**
 * Stateful translator that converts app-server notifications into AG-UI events.
 *
 * One instance per turn (or per run if turns are sequential within one
 * observable). The caller is responsible for creating a fresh translator
 * when a new AG-UI run starts.
 */
export class AppServerEventTranslator {
  private readonly textTracker = new Map<string, TextState>();
  private activeAgentMessageIds: string[] = [];
  private readonly toolTracker = new Map<string, ToolState>();
  private readonly reasoningTracker = new Map<string, ReasoningState>();
  private readonly runMessages: Message[] = [];

  /** Current turnId (set by turn/started, cleared by turn/completed). */
  private currentTurnId: string | null = null;

  /** Whether the turn has reached a terminal state. */
  private turnTerminal = false;

  /** Public read-only accessor for the terminal state. */
  get terminal(): boolean {
    return this.turnTerminal;
  }

  /**
   * When set, no further AG-UI events are produced but turn tracking
   * (notably `turn/completed` → terminal) continues. Used when the AG-UI
   * stream already ended with an interrupt outcome (approval pause) and the
   * run is being cancelled — emitting another terminal into the same stream
   * would be an invalid sequence, yet interruptRun still needs to observe
   * the real `turn/completed(interrupted)` (§11.5 step 3).
   */
  private outputSuppressed = false;

  /** Stop emitting AG-UI events while still tracking turn terminal state. */
  suppressOutput(): void {
    this.outputSuppressed = true;
  }

  /** Failure candidate set by `error` notification (【决策5】). */
  private failureCandidate: string | null = null;

  /** Accumulated usage across turns. */
  private accumulatedUsage = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
  };
  private turnCount = 0;

  // ── Public API ──────────────────────────────────────────────────────────

  /**
   * Translate a single app-server notification into AG-UI events.
   *
   * After a terminal event is produced, further notifications are swallowed
   * (late error/warning after terminal — 【决策5】).
   */
  translate(
    method: string,
    params: unknown,
    ctx: TranslatorContext,
  ): TranslationResult {
    // Swallow everything after terminal
    if (this.turnTerminal) {
      return { events: [], terminal: false, errorCandidate: false };
    }

    const p = params as Record<string, unknown> | undefined;
    const events: TranslatedEvent[] = [];
    let terminal = false;
    let errorCandidate = false;

    switch (method) {
      // ── Turn lifecycle (§10.1) ──
      case "turn/started":
        events.push(...this.handleTurnStarted(p, ctx));
        break;

      case "turn/completed":
        events.push(...this.handleTurnCompleted(p, ctx));
        terminal = this.turnTerminal;
        break;

      case "error":
        errorCandidate = true;
        this.handleErrorNotification(p);
        break;

      case "warning":
        // Non-terminal, no AG-UI event — just swallow (could log)
        break;

      // ── Agent Message (§10.2) ──
      case "item/started":
        events.push(...this.handleItemStarted(p, ctx));
        break;

      case "item/completed":
        events.push(...this.handleItemCompleted(p, ctx));
        break;

      case "item/agentMessage/delta":
        events.push(...this.handleAgentMessageDelta(p, ctx));
        break;

      // ── Reasoning (§10.3) ──
      case "item/reasoning/summaryTextDelta":
        events.push(...this.handleReasoningSummaryDelta(p, ctx));
        break;

      case "item/reasoning/summaryPartAdded":
        // Segment boundary — no AG-UI event needed, just track
        break;

      case "item/reasoning/textDelta":
        events.push(...this.handleReasoningTextDelta(p, ctx));
        break;

      // ── Command Execution (§10.4) ──
      case "item/commandExecution/outputDelta":
        events.push(...this.handleCommandOutputDelta(p, ctx));
        break;

      // ── File Change (§10.5) ──
      case "item/fileChange/patchUpdated":
        events.push(...this.handleFileChangePatchUpdated(p, ctx));
        break;

      case "turn/diff/updated":
        events.push(...this.handleTurnDiffUpdated(p, ctx));
        break;

      // ── Plan / Usage (§10.7) ──
      case "turn/plan/updated":
        events.push(...this.handlePlanUpdated(p, ctx));
        break;

      case "thread/tokenUsage/updated":
        events.push(...this.handleTokenUsageUpdated(p, ctx));
        break;

      // ── Server request resolved (§11.5 idempotency) ──
      case "serverRequest/resolved":
        // No AG-UI event — approval bridge handles this
        break;

      // ── Thread lifecycle (informational) ──
      case "thread/started":
      case "thread/status/changed":
        // No AG-UI event needed for the run stream
        break;

      // ── Unknown notification ──
      default:
        // Unknown — swallow silently (could log for debugging)
        break;
    }

    if (this.outputSuppressed) {
      return { events: [], terminal, errorCandidate };
    }
    return { events, terminal, errorCandidate };
  }

  /**
   * Called when the app-server process exits without a terminal event.
   * Produces RUN_ERROR using the failure candidate or "process_exited".
   */
  translateProcessExit(ctx: TranslatorContext): TranslationResult {
    if (this.turnTerminal) {
      return { events: [], terminal: false, errorCandidate: false };
    }

    if (this.outputSuppressed) {
      this.turnTerminal = true;
      return { events: [], terminal: true, errorCandidate: false };
    }

    const events: TranslatedEvent[] = [];

    // Close any hanging events
    events.push(...this.closeActiveEvents(ctx));

    const message = this.failureCandidate ?? "process_exited";
    events.push({
      type: EventType.RUN_ERROR,
      threadId: ctx.threadId,
      runId: ctx.runId,
      message,
    });

    this.turnTerminal = true;
    return { events, terminal: true, errorCandidate: false };
  }

  /**
   * Close all active text messages, tool calls, and reasoning blocks.
   * Called before a terminal event to ensure Start/End pairing.
   */
  closeActiveEvents(ctx: TranslatorContext): TranslatedEvent[] {
    const events: TranslatedEvent[] = [];

    // Close hanging tool calls
    for (const [, state] of this.toolTracker) {
      if (!state.ended) {
        events.push({
          type: EventType.TOOL_CALL_END,
          threadId: ctx.threadId,
          runId: ctx.runId,
          toolCallId: state.toolCallId,
        });
        state.ended = true;
      }
    }

    // Close hanging reasoning
    for (const [, state] of this.reasoningTracker) {
      if (!state.ended) {
        events.push({
          type: EventType.REASONING_MESSAGE_END,
          messageId: state.messageId,
        });
        events.push({
          type: EventType.REASONING_END,
          messageId: state.messageId,
        });
        state.ended = true;
      }
    }

    // Close hanging text messages
    for (const [, state] of this.textTracker) {
      if (!state.ended) {
        events.push({
          type: EventType.TEXT_MESSAGE_END,
          threadId: ctx.threadId,
          runId: ctx.runId,
          messageId: state.messageId,
        });
        state.ended = true;
      }
    }

    return events;
  }

  /** Get accumulated run messages for MESSAGES_SNAPSHOT. */
  get messages(): Message[] {
    return [...this.runMessages];
  }

  /** Get final usage data (available after turn/completed). */
  get usage(): RunUsage | null {
    if (this.turnCount === 0) return null;
    return {
      inputTokens: this.accumulatedUsage.inputTokens,
      outputTokens: this.accumulatedUsage.outputTokens,
      cachedInputTokens: this.accumulatedUsage.cachedInputTokens,
      reasoningOutputTokens: this.accumulatedUsage.reasoningOutputTokens,
      cacheCreationInputTokens: 0,
      totalCostUsd: null,
      numTurns: this.turnCount,
      durationApiMs: null,
    };
  }

  // ── Turn lifecycle handlers ─────────────────────────────────────────────

  private handleTurnStarted(
    params: Record<string, unknown> | undefined,
    ctx: TranslatorContext,
  ): TranslatedEvent[] {
    const turn = params?.turn as Turn | undefined;
    if (turn?.id) {
      this.currentTurnId = turn.id;
    }
    // Do NOT emit RUN_STARTED here — the adapter already emitted it
    // before calling turn/start. Emitting a second RUN_STARTED causes
    // "Cannot send RUN_STARTED while a run is still active" in the
    // assistant-ui runtime.
    return [];
  }

  private handleTurnCompleted(
    params: Record<string, unknown> | undefined,
    ctx: TranslatorContext,
  ): TranslatedEvent[] {
    const events: TranslatedEvent[] = [];
    const turn = params?.turn as Turn | undefined;
    const status = turn?.status as TurnStatus | undefined;

    // Accumulate usage from turn
    this.turnCount++;
    // Note: turn/completed doesn't directly carry usage in the notification,
    // but thread/tokenUsage/updated provides it. We use accumulated values.

    // Close any hanging events before terminal
    events.push(...this.closeActiveEvents(ctx));

    switch (status) {
      case "completed": {
        // Flush messages snapshot
        if (this.runMessages.length > 0) {
          events.push({
            type: EventType.MESSAGES_SNAPSHOT,
            messages: [...this.runMessages],
          });
        }
        events.push({
          type: EventType.RUN_FINISHED,
          threadId: ctx.threadId,
          runId: ctx.runId,
        });
        this.turnTerminal = true;
        break;
      }

      case "interrupted": {
        events.push({
          type: EventType.RUN_FINISHED,
          threadId: ctx.threadId,
          runId: ctx.runId,
          outcome: { type: "interrupt" },
        });
        this.turnTerminal = true;
        break;
      }

      case "failed": {
        const turnError = turn?.error as TurnError | undefined;
        const message =
          turnError?.message ??
          this.failureCandidate ??
          "Turn failed with unknown error";
        events.push({
          type: EventType.RUN_ERROR,
          threadId: ctx.threadId,
          runId: ctx.runId,
          message,
        });
        this.turnTerminal = true;
        break;
      }

      default: {
        // Unknown status — treat as error
        const message = `Unknown turn status: ${String(status)}`;
        events.push({
          type: EventType.RUN_ERROR,
          threadId: ctx.threadId,
          runId: ctx.runId,
          message,
        });
        this.turnTerminal = true;
        break;
      }
    }

    this.currentTurnId = null;
    return events;
  }

  private handleErrorNotification(
    params: Record<string, unknown> | undefined,
  ): void {
    // 【决策5】 — error notification never produces a terminal event.
    // Only set the failure candidate for use if turn/completed never arrives.
    const error = params?.error as TurnError | undefined;
    if (error?.message) {
      this.failureCandidate = error.message;
    }
  }

  // ── Item lifecycle handlers ─────────────────────────────────────────────

  private handleItemStarted(
    params: Record<string, unknown> | undefined,
    ctx: TranslatorContext,
  ): TranslatedEvent[] {
    const item = params?.item as ThreadItem | undefined;
    if (!item) return [];

    return this.processItemLifecycle("started", item, params, ctx);
  }

  private handleItemCompleted(
    params: Record<string, unknown> | undefined,
    ctx: TranslatorContext,
  ): TranslatedEvent[] {
    const item = params?.item as ThreadItem | undefined;
    if (!item) return [];

    return this.processItemLifecycle("completed", item, params, ctx);
  }

  // ── Agent Message delta (§10.2) ─────────────────────────────────────────

  private handleAgentMessageDelta(
    params: Record<string, unknown> | undefined,
    ctx: TranslatorContext,
  ): TranslatedEvent[] {
    const itemId = params?.itemId as string | undefined;
    const delta = params?.delta as string | undefined;
    if (!itemId || !delta) return [];

    const state = this.textTracker.get(itemId);
    if (!state || state.ended) return [];

    state.accumulated += delta;
    return [
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        threadId: ctx.threadId,
        runId: ctx.runId,
        messageId: state.messageId,
        delta,
      },
    ];
  }

  // ── Reasoning delta (§10.3) ─────────────────────────────────────────────

  private handleReasoningSummaryDelta(
    params: Record<string, unknown> | undefined,
    ctx: TranslatorContext,
  ): TranslatedEvent[] {
    const itemId = params?.itemId as string | undefined;
    const delta = params?.delta as string | undefined;
    const summaryIndex = params?.summaryIndex as number | undefined;
    if (!itemId || !delta || summaryIndex === undefined) return [];

    const { state, startEvents } = this.ensureReasoningState(itemId, ctx);
    if (!state) return [];

    const prev = state.summaries.get(summaryIndex) ?? "";
    state.summaries.set(summaryIndex, prev + delta);

    // Only emit summary as content if no raw text has been streamed.
    // Raw text (textDelta) is preferred — it's the full reasoning, not
    // just a short title.
    if (state.contentParts.size === 0) {
      return [
        ...startEvents,
        {
          type: EventType.REASONING_MESSAGE_CONTENT,
          messageId: state.messageId,
          delta,
        },
      ];
    }
    return startEvents;
  }

  /**
   * Handle raw reasoning text deltas (the full chain-of-thought).
   *
   * These are preferred over summary deltas — summaries are short titles
   * (e.g. "**Planning frontend skill assessment**"), while text deltas
   * contain the actual reasoning content.
   */
  private handleReasoningTextDelta(
    params: Record<string, unknown> | undefined,
    ctx: TranslatorContext,
  ): TranslatedEvent[] {
    const itemId = params?.itemId as string | undefined;
    const delta = params?.delta as string | undefined;
    const contentIndex = params?.contentIndex as number | undefined;
    if (!itemId || !delta || contentIndex === undefined) return [];

    const { state, startEvents } = this.ensureReasoningState(itemId, ctx);
    if (!state) return [];

    const prev = state.contentParts.get(contentIndex) ?? "";
    state.contentParts.set(contentIndex, prev + delta);

    return [
      ...startEvents,
      {
        type: EventType.REASONING_MESSAGE_CONTENT,
        messageId: state.messageId,
        delta,
      },
    ];
  }

  /**
   * Get or create reasoning state, emitting REASONING_START +
   * REASONING_MESSAGE_START if this is the first delta for the item.
   *
   * Returns the state and any start events that need to be emitted before
   * content deltas.
   */
  private ensureReasoningState(
    itemId: string,
    ctx: TranslatorContext,
  ): { state: ReasoningState | null; startEvents: TranslatedEvent[] } {
    let state = this.reasoningTracker.get(itemId);
    if (state) return { state, startEvents: [] };

    const messageId = `${ctx.runId}-${itemId}`;
    state = {
      itemId,
      messageId,
      summaries: new Map(),
      contentParts: new Map(),
      started: true, // mark as started since we emit START below
      ended: false,
    };
    this.reasoningTracker.set(itemId, state);

    // Emit REASONING_START + REASONING_MESSAGE_START immediately so
    // CONTENT deltas are properly framed (delta before item/started).
    const startEvents: TranslatedEvent[] = [
      { type: EventType.REASONING_START, messageId },
      { type: EventType.REASONING_MESSAGE_START, messageId, role: "reasoning" },
    ];
    return { state, startEvents };
  }

  // ── Command output delta (§10.4) ────────────────────────────────────────

  private handleCommandOutputDelta(
    params: Record<string, unknown> | undefined,
    ctx: TranslatorContext,
  ): TranslatedEvent[] {
    const itemId = params?.itemId as string | undefined;
    const delta = params?.delta as string | undefined;
    if (!itemId || !delta) return [];

    const state = this.toolTracker.get(itemId);
    if (!state || state.ended) return [];

    state.outputBuffer += delta;
    // Emit as Custom Event for streaming tool output
    return [
      {
        type: EventType.CUSTOM,
        threadId: ctx.threadId,
        runId: ctx.runId,
        name: "command_output_delta",
        value: { itemId, delta },
      },
    ];
  }

  // ── File change patch (§10.5) ───────────────────────────────────────────

  private handleFileChangePatchUpdated(
    params: Record<string, unknown> | undefined,
    ctx: TranslatorContext,
  ): TranslatedEvent[] {
    const itemId = params?.itemId as string | undefined;
    const changes = params?.changes as unknown[] | undefined;
    if (!itemId || !changes) return [];

    return [
      {
        type: EventType.CUSTOM,
        threadId: ctx.threadId,
        runId: ctx.runId,
        name: "file_change_patch",
        value: { itemId, changes },
      },
    ];
  }

  // ── Turn diff (§10.5) ───────────────────────────────────────────────────

  private handleTurnDiffUpdated(
    params: Record<string, unknown> | undefined,
    ctx: TranslatorContext,
  ): TranslatedEvent[] {
    const diff = params?.diff as string | undefined;
    if (!diff) return [];

    return [
      {
        type: EventType.CUSTOM,
        threadId: ctx.threadId,
        runId: ctx.runId,
        name: "turn_diff",
        value: diff,
      },
    ];
  }

  // ── Plan (§10.7) ────────────────────────────────────────────────────────

  private handlePlanUpdated(
    params: Record<string, unknown> | undefined,
    ctx: TranslatorContext,
  ): TranslatedEvent[] {
    const explanation = params?.explanation as string | null | undefined;
    const plan = params?.plan as Array<{ step: string; status: string }> | undefined;
    if (!plan) return [];

    return [
      {
        type: EventType.CUSTOM,
        threadId: ctx.threadId,
        runId: ctx.runId,
        name: "plan_updated",
        value: { explanation: explanation ?? null, plan },
      },
    ];
  }

  // ── Token usage (§10.7) ─────────────────────────────────────────────────

  private handleTokenUsageUpdated(
    params: Record<string, unknown> | undefined,
    _ctx: TranslatorContext,
  ): TranslatedEvent[] {
    const tokenUsage = params?.tokenUsage as
      | {
          total: {
            totalTokens: number;
            inputTokens: number;
            cachedInputTokens: number;
            outputTokens: number;
            reasoningOutputTokens: number;
          };
          last: {
            totalTokens: number;
            inputTokens: number;
            cachedInputTokens: number;
            outputTokens: number;
            reasoningOutputTokens: number;
          };
          modelContextWindow: number | null;
        }
      | undefined;

    if (!tokenUsage) return [];

    // Update accumulated usage
    this.accumulatedUsage = {
      inputTokens: tokenUsage.total.inputTokens,
      cachedInputTokens: tokenUsage.total.cachedInputTokens,
      outputTokens: tokenUsage.total.outputTokens,
      reasoningOutputTokens: tokenUsage.total.reasoningOutputTokens,
    };

    return [
      {
        type: EventType.CUSTOM,
        name: "token_usage",
        value: tokenUsage,
      },
    ];
  }

  // ── Item lifecycle dispatcher ───────────────────────────────────────────

  private processItemLifecycle(
    phase: "started" | "completed",
    item: ThreadItem,
    params: Record<string, unknown> | undefined,
    ctx: TranslatorContext,
  ): TranslatedEvent[] {
    const events: TranslatedEvent[] = [];
    // Always use ctx.threadId (the AG-UI threadId), NOT params.threadId
    // (which is the codex threadId — a different value).
    const threadId = ctx.threadId;

    switch (item.type) {
      case "agentMessage":
        events.push(
          ...this.handleAgentMessageItem(phase, item, threadId, ctx),
        );
        break;

      case "reasoning":
        events.push(
          ...this.handleReasoningItem(phase, item, threadId, ctx),
        );
        break;

      case "commandExecution":
        events.push(
          ...this.handleCommandExecutionItem(phase, item, threadId, ctx),
        );
        break;

      case "fileChange":
        events.push(
          ...this.handleFileChangeItem(phase, item, threadId, ctx),
        );
        break;

      case "mcpToolCall":
        events.push(
          ...this.handleMcpToolCallItem(phase, item, threadId, ctx),
        );
        break;

      case "dynamicToolCall":
        events.push(
          ...this.handleDynamicToolCallItem(phase, item, threadId, ctx),
        );
        break;

      case "webSearch":
        events.push(
          ...this.handleWebSearchItem(phase, item, threadId, ctx),
        );
        break;

      case "imageView":
        events.push(
          ...this.handleImageViewItem(phase, item, threadId, ctx),
        );
        break;

      case "enteredReviewMode":
        if (phase === "started") {
          events.push({
            type: EventType.CUSTOM,
            threadId,
            runId: ctx.runId,
            name: "review_started",
            value: { review: item.review },
          });
        }
        break;

      case "exitedReviewMode":
        if (phase === "started") {
          events.push({
            type: EventType.CUSTOM,
            threadId,
            runId: ctx.runId,
            name: "review_finished",
            value: { review: item.review },
          });
        }
        break;

      case "contextCompaction":
        if (phase === "started") {
          events.push({
            type: EventType.CUSTOM,
            threadId,
            runId: ctx.runId,
            name: "context_compaction",
            value: { itemId: item.id },
          });
        }
        break;

      case "collabAgentToolCall":
        events.push(
          ...this.handleCollabToolCallItem(phase, item, threadId, ctx),
        );
        break;

      case "imageGeneration":
        events.push(
          ...this.handleImageGenerationItem(phase, item, threadId, ctx),
        );
        break;

      default:
        // Unknown item type — don't fail, don't fake a known tool
        // (§10.6: write warning + don't fail Turn)
        break;
    }

    return events;
  }

  // ── Agent Message item ──────────────────────────────────────────────────

  private handleAgentMessageItem(
    phase: "started" | "completed",
    item: Extract<ThreadItem, { type: "agentMessage" }>,
    threadId: string,
    ctx: TranslatorContext,
  ): TranslatedEvent[] {
    const events: TranslatedEvent[] = [];
    const messageId = `${ctx.runId}-${item.id}`;

    if (phase === "started") {
      if (!this.textTracker.has(item.id)) {
        this.textTracker.set(item.id, {
          itemId: item.id,
          messageId,
          accumulated: "",
          ended: false,
        });
        // Replace (not push): the new text message becomes the parent for
        // subsequent tool calls in this turn. The previous message ID is
        // cleared — its text is either a standalone answer or already
        // parented its own tool group.
        this.activeAgentMessageIds = [messageId];
        events.push({
          type: EventType.TEXT_MESSAGE_START,
          threadId,
          runId: ctx.runId,
          messageId,
          role: "assistant",
        });
      }
    } else {
      // completed — finalize text + emit END
      const state = this.textTracker.get(item.id);
      if (state && !state.ended) {
        // The completed item's text is the authoritative final text.
        // If deltas already provided the full text, no correction needed.
        // If there's a gap (item.text longer than accumulated), emit the
        // remainder as a final content delta.
        const fullText = item.text ?? "";
        const prev = state.accumulated;
        const delta = fullText.slice(prev.length);
        if (delta) {
          state.accumulated = fullText;
          events.push({
            type: EventType.TEXT_MESSAGE_CONTENT,
            threadId,
            runId: ctx.runId,
            messageId,
            delta,
          });
        }

        events.push({
          type: EventType.TEXT_MESSAGE_END,
          threadId,
          runId: ctx.runId,
          messageId,
        });

        // Only add to runMessages if phase is not "commentary"
        // (commentary is interim, not the final answer — §10.2)
        const messagePhase = item.phase as MessagePhase | null;
        if (messagePhase !== "commentary") {
          this.runMessages.push({
            id: messageId,
            role: "assistant",
            content: fullText,
          });
        }

        state.ended = true;
        // Do NOT remove from activeAgentMessageIds here.
        // Codex completes agentMessage items before starting tool items,
        // so the message ID must stay active for subsequent tool calls to
        // reference as parentMessageId. It will be replaced when the next
        // TEXT_MESSAGE_START arrives.
      }
    }

    return events;
  }

  // ── Reasoning item ──────────────────────────────────────────────────────

  private handleReasoningItem(
    phase: "started" | "completed",
    item: Extract<ThreadItem, { type: "reasoning" }>,
    threadId: string,
    ctx: TranslatorContext,
  ): TranslatedEvent[] {
    const events: TranslatedEvent[] = [];
    const messageId = `${ctx.runId}-${item.id}`;

    if (phase === "started") {
      if (!this.reasoningTracker.has(item.id)) {
        const state: ReasoningState = {
          itemId: item.id,
          messageId,
          summaries: new Map(),
          contentParts: new Map(),
          started: false,
          ended: false,
        };
        this.reasoningTracker.set(item.id, state);
      }
      const state = this.reasoningTracker.get(item.id)!;
      if (!state.started) {
        state.started = true;
        events.push({
          type: EventType.REASONING_START,
          messageId,
        });
        events.push({
          type: EventType.REASONING_MESSAGE_START,
          messageId,
          role: "reasoning",
        });
      }
    } else {
      // completed
      const state = this.reasoningTracker.get(item.id);
      if (state && !state.ended) {
        // If no deltas were streamed, flush from item.content (preferred)
        // or item.summary as fallback.
        const streamedContent = [...state.contentParts.values()].join("");
        const streamedSummary = [...state.summaries.values()].join("");
        if (!streamedContent && !streamedSummary) {
          const fullText = item.content?.join("") || item.summary?.join("") || "";
          if (fullText) {
            events.push({
              type: EventType.REASONING_MESSAGE_CONTENT,
              messageId,
              delta: fullText,
            });
          }
        }

        events.push({
          type: EventType.REASONING_MESSAGE_END,
          messageId,
        });
        events.push({
          type: EventType.REASONING_END,
          messageId,
        });
        state.ended = true;
      }
    }

    return events;
  }

  // ── Command Execution item ──────────────────────────────────────────────

  private handleCommandExecutionItem(
    phase: "started" | "completed",
    item: Extract<ThreadItem, { type: "commandExecution" }>,
    threadId: string,
    ctx: TranslatorContext,
  ): TranslatedEvent[] {
    const events: TranslatedEvent[] = [];
    const toolCallId = `${ctx.runId}-${item.id}`;

    if (phase === "started") {
      if (!this.toolTracker.has(item.id)) {
        this.toolTracker.set(item.id, {
          itemId: item.id,
          toolCallId,
          argsSent: false,
          ended: false,
          outputBuffer: "",
        });
        events.push({
          type: EventType.TOOL_CALL_START,
          threadId,
          runId: ctx.runId,
          toolCallId,
          toolCallName: "command_execution",
          ...(this.activeAgentMessageIds.at(-1)
            ? { parentMessageId: this.activeAgentMessageIds.at(-1) }
            : {}),
        });
        // Send args immediately with command + cwd
        events.push({
          type: EventType.TOOL_CALL_ARGS,
          threadId,
          runId: ctx.runId,
          toolCallId,
          delta: JSON.stringify(
            { command: item.command, cwd: item.cwd },
            null,
            2,
          ),
        });
        const state = this.toolTracker.get(item.id)!;
        state.argsSent = true;
      }
    } else {
      // completed
      const state = this.toolTracker.get(item.id);
      if (state && !state.ended) {
        // Emit result
        const resultContent = JSON.stringify(
          {
            status: item.status,
            exitCode: item.exitCode,
            output: item.aggregatedOutput ?? state.outputBuffer,
            durationMs: item.durationMs,
          },
          null,
          2,
        );
        const resultMsgId = `${toolCallId}-result`;
        events.push({
          type: EventType.TOOL_CALL_RESULT,
          threadId,
          runId: ctx.runId,
          messageId: resultMsgId,
          toolCallId,
          content: resultContent,
          role: "tool",
        });
        this.runMessages.push({
          id: resultMsgId,
          role: "tool",
          content: resultContent,
          toolCallId,
        });

        events.push({
          type: EventType.TOOL_CALL_END,
          threadId,
          runId: ctx.runId,
          toolCallId,
        });
        state.ended = true;
      }
    }

    return events;
  }

  // ── File Change item ────────────────────────────────────────────────────

  private handleFileChangeItem(
    phase: "started" | "completed",
    item: Extract<ThreadItem, { type: "fileChange" }>,
    threadId: string,
    ctx: TranslatorContext,
  ): TranslatedEvent[] {
    const events: TranslatedEvent[] = [];
    const toolCallId = `${ctx.runId}-${item.id}`;

    if (phase === "started") {
      if (!this.toolTracker.has(item.id)) {
        this.toolTracker.set(item.id, {
          itemId: item.id,
          toolCallId,
          argsSent: false,
          ended: false,
          outputBuffer: "",
        });
        events.push({
          type: EventType.TOOL_CALL_START,
          threadId,
          runId: ctx.runId,
          toolCallId,
          toolCallName: "file_change",
          ...(this.activeAgentMessageIds.at(-1)
            ? { parentMessageId: this.activeAgentMessageIds.at(-1) }
            : {}),
        });
        events.push({
          type: EventType.TOOL_CALL_ARGS,
          threadId,
          runId: ctx.runId,
          toolCallId,
          delta: JSON.stringify({ changes: item.changes }, null, 2),
        });
        const state = this.toolTracker.get(item.id)!;
        state.argsSent = true;
      }
    } else {
      const state = this.toolTracker.get(item.id);
      if (state && !state.ended) {
        const resultContent = JSON.stringify(
          { status: item.status, changes: item.changes },
          null,
          2,
        );
        const resultMsgId = `${toolCallId}-result`;
        events.push({
          type: EventType.TOOL_CALL_RESULT,
          threadId,
          runId: ctx.runId,
          messageId: resultMsgId,
          toolCallId,
          content: resultContent,
          role: "tool",
        });
        this.runMessages.push({
          id: resultMsgId,
          role: "tool",
          content: resultContent,
          toolCallId,
        });
        events.push({
          type: EventType.TOOL_CALL_END,
          threadId,
          runId: ctx.runId,
          toolCallId,
        });
        state.ended = true;
      }
    }

    return events;
  }

  // ── MCP Tool Call item ──────────────────────────────────────────────────

  private handleMcpToolCallItem(
    phase: "started" | "completed",
    item: Extract<ThreadItem, { type: "mcpToolCall" }>,
    threadId: string,
    ctx: TranslatorContext,
  ): TranslatedEvent[] {
    const events: TranslatedEvent[] = [];
    const toolCallId = `${ctx.runId}-${item.id}`;
    const toolName = `${item.server}.${item.tool}`;

    if (phase === "started") {
      if (!this.toolTracker.has(item.id)) {
        this.toolTracker.set(item.id, {
          itemId: item.id,
          toolCallId,
          argsSent: false,
          ended: false,
          outputBuffer: "",
        });
        events.push({
          type: EventType.TOOL_CALL_START,
          threadId,
          runId: ctx.runId,
          toolCallId,
          toolCallName: toolName,
          ...(this.activeAgentMessageIds.at(-1)
            ? { parentMessageId: this.activeAgentMessageIds.at(-1) }
            : {}),
        });
        events.push({
          type: EventType.TOOL_CALL_ARGS,
          threadId,
          runId: ctx.runId,
          toolCallId,
          delta: JSON.stringify(item.arguments, null, 2),
        });
        const state = this.toolTracker.get(item.id)!;
        state.argsSent = true;
      }
    } else {
      const state = this.toolTracker.get(item.id);
      if (state && !state.ended) {
        let resultContent: string;
        if (item.error) {
          resultContent = JSON.stringify({ error: item.error.message }, null, 2);
        } else if (item.result) {
          resultContent = JSON.stringify(item.result, null, 2);
        } else {
          resultContent = "{}";
        }
        const resultMsgId = `${toolCallId}-result`;
        events.push({
          type: EventType.TOOL_CALL_RESULT,
          threadId,
          runId: ctx.runId,
          messageId: resultMsgId,
          toolCallId,
          content: resultContent,
          role: "tool",
        });
        this.runMessages.push({
          id: resultMsgId,
          role: "tool",
          content: resultContent,
          toolCallId,
        });
        events.push({
          type: EventType.TOOL_CALL_END,
          threadId,
          runId: ctx.runId,
          toolCallId,
        });
        state.ended = true;
      }
    }

    return events;
  }

  // ── Dynamic Tool Call item ──────────────────────────────────────────────

  private handleDynamicToolCallItem(
    phase: "started" | "completed",
    item: Extract<ThreadItem, { type: "dynamicToolCall" }>,
    threadId: string,
    ctx: TranslatorContext,
  ): TranslatedEvent[] {
    const events: TranslatedEvent[] = [];
    const toolCallId = `${ctx.runId}-${item.id}`;
    const toolName = `dynamic:${item.tool}`;

    if (phase === "started") {
      if (!this.toolTracker.has(item.id)) {
        this.toolTracker.set(item.id, {
          itemId: item.id,
          toolCallId,
          argsSent: false,
          ended: false,
          outputBuffer: "",
        });
        events.push({
          type: EventType.TOOL_CALL_START,
          threadId,
          runId: ctx.runId,
          toolCallId,
          toolCallName: toolName,
          ...(this.activeAgentMessageIds.at(-1)
            ? { parentMessageId: this.activeAgentMessageIds.at(-1) }
            : {}),
        });
        events.push({
          type: EventType.TOOL_CALL_ARGS,
          threadId,
          runId: ctx.runId,
          toolCallId,
          delta: JSON.stringify(item.arguments, null, 2),
        });
        const state = this.toolTracker.get(item.id)!;
        state.argsSent = true;
      }
    } else {
      const state = this.toolTracker.get(item.id);
      if (state && !state.ended) {
        const resultContent = JSON.stringify(
          {
            status: item.status,
            success: item.success,
            contentItems: item.contentItems,
          },
          null,
          2,
        );
        const resultMsgId = `${toolCallId}-result`;
        events.push({
          type: EventType.TOOL_CALL_RESULT,
          threadId,
          runId: ctx.runId,
          messageId: resultMsgId,
          toolCallId,
          content: resultContent,
          role: "tool",
        });
        this.runMessages.push({
          id: resultMsgId,
          role: "tool",
          content: resultContent,
          toolCallId,
        });
        events.push({
          type: EventType.TOOL_CALL_END,
          threadId,
          runId: ctx.runId,
          toolCallId,
        });
        state.ended = true;
      }
    }

    return events;
  }

  // ── Web Search item ─────────────────────────────────────────────────────

  private handleWebSearchItem(
    phase: "started" | "completed",
    item: Extract<ThreadItem, { type: "webSearch" }>,
    threadId: string,
    ctx: TranslatorContext,
  ): TranslatedEvent[] {
    const events: TranslatedEvent[] = [];
    const toolCallId = `${ctx.runId}-${item.id}`;

    if (phase === "started") {
      if (!this.toolTracker.has(item.id)) {
        this.toolTracker.set(item.id, {
          itemId: item.id,
          toolCallId,
          argsSent: false,
          ended: false,
          outputBuffer: "",
        });
        events.push({
          type: EventType.TOOL_CALL_START,
          threadId,
          runId: ctx.runId,
          toolCallId,
          toolCallName: "web_search",
          ...(this.activeAgentMessageIds.at(-1)
            ? { parentMessageId: this.activeAgentMessageIds.at(-1) }
            : {}),
        });
        events.push({
          type: EventType.TOOL_CALL_ARGS,
          threadId,
          runId: ctx.runId,
          toolCallId,
          delta: JSON.stringify({ query: item.query }, null, 2),
        });
        const state = this.toolTracker.get(item.id)!;
        state.argsSent = true;
      }
    } else {
      const state = this.toolTracker.get(item.id);
      if (state && !state.ended) {
        const resultContent = JSON.stringify({ query: item.query }, null, 2);
        const resultMsgId = `${toolCallId}-result`;
        events.push({
          type: EventType.TOOL_CALL_RESULT,
          threadId,
          runId: ctx.runId,
          messageId: resultMsgId,
          toolCallId,
          content: resultContent,
          role: "tool",
        });
        this.runMessages.push({
          id: resultMsgId,
          role: "tool",
          content: resultContent,
          toolCallId,
        });
        events.push({
          type: EventType.TOOL_CALL_END,
          threadId,
          runId: ctx.runId,
          toolCallId,
        });
        state.ended = true;
      }
    }

    return events;
  }

  // ── Image View item ─────────────────────────────────────────────────────

  private handleImageViewItem(
    phase: "started" | "completed",
    item: Extract<ThreadItem, { type: "imageView" }>,
    threadId: string,
    ctx: TranslatorContext,
  ): TranslatedEvent[] {
    const events: TranslatedEvent[] = [];
    const toolCallId = `${ctx.runId}-${item.id}`;

    if (phase === "started") {
      if (!this.toolTracker.has(item.id)) {
        this.toolTracker.set(item.id, {
          itemId: item.id,
          toolCallId,
          argsSent: false,
          ended: false,
          outputBuffer: "",
        });
        events.push({
          type: EventType.TOOL_CALL_START,
          threadId,
          runId: ctx.runId,
          toolCallId,
          toolCallName: "image_view",
          ...(this.activeAgentMessageIds.at(-1)
            ? { parentMessageId: this.activeAgentMessageIds.at(-1) }
            : {}),
        });
        events.push({
          type: EventType.TOOL_CALL_ARGS,
          threadId,
          runId: ctx.runId,
          toolCallId,
          delta: JSON.stringify({ path: item.path }, null, 2),
        });
        const state = this.toolTracker.get(item.id)!;
        state.argsSent = true;
      }
    } else {
      const state = this.toolTracker.get(item.id);
      if (state && !state.ended) {
        const resultContent = JSON.stringify({ path: item.path }, null, 2);
        const resultMsgId = `${toolCallId}-result`;
        events.push({
          type: EventType.TOOL_CALL_RESULT,
          threadId,
          runId: ctx.runId,
          messageId: resultMsgId,
          toolCallId,
          content: resultContent,
          role: "tool",
        });
        this.runMessages.push({
          id: resultMsgId,
          role: "tool",
          content: resultContent,
          toolCallId,
        });
        events.push({
          type: EventType.TOOL_CALL_END,
          threadId,
          runId: ctx.runId,
          toolCallId,
        });
        state.ended = true;
      }
    }

    return events;
  }

  // ── Collab Agent Tool Call item ─────────────────────────────────────────

  private handleCollabToolCallItem(
    phase: "started" | "completed",
    item: Extract<ThreadItem, { type: "collabAgentToolCall" }>,
    threadId: string,
    ctx: TranslatorContext,
  ): TranslatedEvent[] {
    const events: TranslatedEvent[] = [];
    const toolCallId = `${ctx.runId}-${item.id}`;
    const toolName = `collab:${item.tool}`;

    if (phase === "started") {
      if (!this.toolTracker.has(item.id)) {
        this.toolTracker.set(item.id, {
          itemId: item.id,
          toolCallId,
          argsSent: false,
          ended: false,
          outputBuffer: "",
        });
        events.push({
          type: EventType.TOOL_CALL_START,
          threadId,
          runId: ctx.runId,
          toolCallId,
          toolCallName: toolName,
          ...(this.activeAgentMessageIds.at(-1)
            ? { parentMessageId: this.activeAgentMessageIds.at(-1) }
            : {}),
        });
        const args = {
          tool: item.tool,
          status: item.status,
          senderThreadId: item.senderThreadId,
          receiverThreadIds: item.receiverThreadIds,
          prompt: item.prompt,
          model: item.model,
        };
        events.push({
          type: EventType.TOOL_CALL_ARGS,
          threadId,
          runId: ctx.runId,
          toolCallId,
          delta: JSON.stringify(args, null, 2),
        });
        const state = this.toolTracker.get(item.id)!;
        state.argsSent = true;
      }
    } else {
      const state = this.toolTracker.get(item.id);
      if (state && !state.ended) {
        const resultContent = JSON.stringify(
          { tool: item.tool, status: item.status },
          null,
          2,
        );
        const resultMsgId = `${toolCallId}-result`;
        events.push({
          type: EventType.TOOL_CALL_RESULT,
          threadId,
          runId: ctx.runId,
          messageId: resultMsgId,
          toolCallId,
          content: resultContent,
          role: "tool",
        });
        this.runMessages.push({
          id: resultMsgId,
          role: "tool",
          content: resultContent,
          toolCallId,
        });
        events.push({
          type: EventType.TOOL_CALL_END,
          threadId,
          runId: ctx.runId,
          toolCallId,
        });
        state.ended = true;
      }
    }

    return events;
  }

  // ── Image Generation item ───────────────────────────────────────────────

  private handleImageGenerationItem(
    phase: "started" | "completed",
    item: Extract<ThreadItem, { type: "imageGeneration" }>,
    threadId: string,
    ctx: TranslatorContext,
  ): TranslatedEvent[] {
    const events: TranslatedEvent[] = [];
    const toolCallId = `${ctx.runId}-${item.id}`;

    if (phase === "started") {
      if (!this.toolTracker.has(item.id)) {
        this.toolTracker.set(item.id, {
          itemId: item.id,
          toolCallId,
          argsSent: false,
          ended: false,
          outputBuffer: "",
        });
        events.push({
          type: EventType.TOOL_CALL_START,
          threadId,
          runId: ctx.runId,
          toolCallId,
          toolCallName: "image_generation",
          ...(this.activeAgentMessageIds.at(-1)
            ? { parentMessageId: this.activeAgentMessageIds.at(-1) }
            : {}),
        });
        events.push({
          type: EventType.TOOL_CALL_ARGS,
          threadId,
          runId: ctx.runId,
          toolCallId,
          delta: JSON.stringify(
            { status: item.status, revisedPrompt: item.revisedPrompt },
            null,
            2,
          ),
        });
        const state = this.toolTracker.get(item.id)!;
        state.argsSent = true;
      }
    } else {
      const state = this.toolTracker.get(item.id);
      if (state && !state.ended) {
        const resultContent = JSON.stringify(
          { status: item.status, result: item.result },
          null,
          2,
        );
        const resultMsgId = `${toolCallId}-result`;
        events.push({
          type: EventType.TOOL_CALL_RESULT,
          threadId,
          runId: ctx.runId,
          messageId: resultMsgId,
          toolCallId,
          content: resultContent,
          role: "tool",
        });
        this.runMessages.push({
          id: resultMsgId,
          role: "tool",
          content: resultContent,
          toolCallId,
        });
        events.push({
          type: EventType.TOOL_CALL_END,
          threadId,
          runId: ctx.runId,
          toolCallId,
        });
        state.ended = true;
      }
    }

    return events;
  }
}
