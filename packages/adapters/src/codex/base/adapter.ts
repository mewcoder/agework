import { Observable, Subscriber } from "rxjs";
import { AbstractAgent, EventType, randomUUID } from "@ag-ui/client";
import type { BaseEvent, RunAgentInput, Message } from "@ag-ui/core";
import type {
  ThreadEvent,
  ThreadItem,
  McpToolCallItem,
  CommandExecutionItem,
  FileChangeItem,
  WebSearchItem,
  TodoListItem,
  ErrorItem,
  ThreadOptions,
  Usage,
} from "@openai/codex-sdk";

import type {
  CodexAgentAdapterConfig,
  CodexClientLike,
  ProcessedEvent,
} from "./types";
import { ALLOWED_FORWARDED_PROPS } from "./config";
import { hasState, processMessages, buildStateContextAddendum } from "./utils";

/** Reconnecting... N/M errors emitted by codex exec — safe to ignore. */
const RETRYABLE_ERROR_RE = /^Reconnecting\.\.\. \d+\/\d+ /;

/** Per-turn state for a tool-like item (command_execution, mcp_tool_call, …). */
type ToolState = {
  argsSent: boolean;
  ended: boolean;
};

/** Result data captured at the end of a Codex run, analogous to Claude SDK's result message. */
type CodexResultData = {
  isError: boolean;
  errorMessage?: string;
  numTurns: number;
  durationMs?: number;
  usage: Usage | Record<string, unknown>;
};

type TraceContext = {
  runId: string;
  threadId: string;
};

export class CodexAgentAdapter extends AbstractAgent {
  private config: CodexAgentAdapterConfig;
  /** Maps AG-UI threadId → Codex session thread_id for multi-turn resume. */
  private sessions = new Map<string, string>();
  /** Maps AG-UI threadId → in-flight run's AbortController, so callers can interrupt it. */
  private activeRuns = new Map<string, AbortController>();

  constructor(config: CodexAgentAdapterConfig = {}) {
    super(config);
    this.config = config;
  }

  public clearSession(threadId: string): void {
    this.sessions.delete(threadId);
  }

  public clone(): CodexAgentAdapter {
    const cloned = super.clone() as CodexAgentAdapter;
    cloned.config = { ...this.config };
    return cloned;
  }

  /** Aborts the in-flight Codex subprocess(es) for this adapter instance, if any. */
  public async interrupt(threadId?: string): Promise<void> {
    if (threadId) {
      this.activeRuns.get(threadId)?.abort();
      return;
    }
    for (const controller of this.activeRuns.values()) controller.abort();
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<ProcessedEvent>((subscriber) => {
      const threadId = input.threadId ?? "default";
      const runId = input.runId ?? randomUUID();

      this.executeRun(input, threadId, runId, subscriber).catch((error) => {
        subscriber.error(error);
      });
    });
  }

  private async executeRun(
    input: RunAgentInput,
    threadId: string,
    runId: string,
    subscriber: Subscriber<ProcessedEvent>
  ): Promise<void> {
    const runCtx = {
      lastResultData: undefined as CodexResultData | undefined,
    };
    const runStartMs = Date.now();
    const abortController = new AbortController();
    this.activeRuns.set(threadId, abortController);

    try {
      subscriber.next({ type: EventType.RUN_STARTED, threadId, runId });

      if (hasState(input.state)) {
        subscriber.next({
          type: EventType.STATE_SNAPSHOT,
          snapshot: input.state,
        });
      }

      const { userMessage } = processMessages(input);
      const traceContext = { runId, threadId };
      const codexClient = await this.getCodexClient(input, traceContext);
      const threadOptions = this.buildThreadOptions(input);

      // forwardedProps.agentSessionId 用于跨实例多轮续话
      const fp = (input.forwardedProps ?? {}) as Record<string, unknown>;
      const agentSessionId = fp.agentSessionId as string | undefined;
      const existingCodexThreadId =
        agentSessionId ?? this.sessions.get(threadId);
      const isNewThread = !existingCodexThreadId;
      this.trace("sdk.codex.input", {
        method: existingCodexThreadId ? "resumeThread" : "startThread",
        arguments: existingCodexThreadId
          ? { id: existingCodexThreadId, options: threadOptions }
          : { options: threadOptions },
      }, traceContext);
      const thread = existingCodexThreadId
        ? codexClient.resumeThread(existingCodexThreadId, threadOptions)
        : codexClient.startThread(threadOptions);

      this.trace("sdk.codex.input", {
        method: "runStreamed",
        arguments: { input: userMessage },
      }, traceContext);
      const { events } = await thread.runStreamed(userMessage, {
        signal: abortController.signal,
      });
      await this.translateStream(
        events,
        threadId,
        runId,
        input,
        isNewThread,
        subscriber,
        runCtx
      );

      // Compute duration if not already set by a failed turn
      if (
        runCtx.lastResultData &&
        runCtx.lastResultData.durationMs === undefined
      ) {
        runCtx.lastResultData.durationMs = Date.now() - runStartMs;
      }
      subscriber.next({
        type: EventType.RUN_FINISHED,
        threadId,
        runId,
        result: runCtx.lastResultData,
      });
      subscriber.complete();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.trace("sdk.codex.error", error, { runId, threadId });
      console.error(`[CodexAdapter] Error:`, error);

      runCtx.lastResultData = {
        isError: true,
        errorMessage: message,
        numTurns: 0,
        durationMs: Date.now() - runStartMs,
        usage: {},
      };

      subscriber.next({ type: EventType.RUN_ERROR, threadId, runId, message });
      subscriber.complete();
    } finally {
      if (this.activeRuns.get(threadId) === abortController) {
        this.activeRuns.delete(threadId);
      }
    }
  }

  private async translateStream(
    events: AsyncGenerator<ThreadEvent>,
    threadId: string,
    runId: string,
    input: RunAgentInput,
    isNewThread: boolean,
    subscriber: Subscriber<ProcessedEvent>,
    runCtx: { lastResultData: CodexResultData | undefined }
  ): Promise<void> {
    const textTracker = new Map<string, string>();
    const activeAgentMessageIds: string[] = [];
    const toolTracker = new Map<string, ToolState>();
    const runMessages: Message[] = [];
    let turnCount = 0;
    let hadAgentMessageThisTurn = false;
    let accumulatedUsage: Usage = {
      input_tokens: 0,
      cached_input_tokens: 0,
      output_tokens: 0,
      reasoning_output_tokens: 0,
    };
    const traceContext = { runId, threadId };

    for await (const event of events) {
      this.trace("sdk.codex.output", event, traceContext);
      switch (event.type) {
        case "thread.started":
          this.sessions.set(threadId, event.thread_id);
          if (isNewThread) {
            subscriber.next({
              type: EventType.CUSTOM,
              name: "agent.sessionId",
              value: event.thread_id,
            });
          }
          break;

        case "turn.started":
          hadAgentMessageThisTurn = false;
          break;

        case "item.started":
        case "item.updated":
        case "item.completed":
          if (
            event.type === "item.completed" &&
            event.item.type === "agent_message"
          ) {
            hadAgentMessageThisTurn = true;
          }
          this.handleItemEvent(
            event.type,
            event.item,
            threadId,
            runId,
            subscriber,
            textTracker,
            activeAgentMessageIds,
            toolTracker,
            runMessages
          );
          break;

        case "turn.completed": {
          turnCount++;
          accumulatedUsage.input_tokens += event.usage.input_tokens;
          accumulatedUsage.cached_input_tokens +=
            event.usage.cached_input_tokens;
          accumulatedUsage.output_tokens += event.usage.output_tokens;
          accumulatedUsage.reasoning_output_tokens +=
            event.usage.reasoning_output_tokens;

          if (hadAgentMessageThisTurn) {
            // Agent replied to the user this turn. Wait for the SDK stream to
            // drain before RUN_FINISHED so any subprocess side effects are done.
            runCtx.lastResultData = {
              isError: false,
              numTurns: turnCount,
              usage: accumulatedUsage,
            };
            this.flushMessages(input, runMessages, subscriber);
            try {
              await this.drainGenerator(events, traceContext);
            } catch (error) {
              // The agent already replied successfully this turn — a
              // trailing error/turn.failed seen only during post-completion
              // drain must not retroactively flip a delivered answer into
              // RUN_ERROR.
              console.error(
                `[CodexAdapter] Error while draining after a successful turn:`,
                error
              );
            }
            return;
          }
          break;
        }

        case "turn.failed": {
          // Record failure in result data instead of throwing immediately
          runCtx.lastResultData = {
            isError: true,
            errorMessage: event.error.message,
            numTurns: turnCount,
            usage: accumulatedUsage,
          };
          throw new Error(event.error.message);
        }

        case "error":
          if (RETRYABLE_ERROR_RE.test(event.message)) {
            console.warn(
              `[CodexAdapter] Retryable stream error, continuing: ${event.message}`
            );
            break;
          }
          throw new Error(event.message);
      }
    }

    // Set successful result data if not already set by a failed turn
    if (!runCtx.lastResultData) {
      runCtx.lastResultData = {
        isError: false,
        numTurns: turnCount,
        usage: accumulatedUsage,
      };
    }

    this.flushMessages(input, runMessages, subscriber);
  }

  private flushMessages(
    input: RunAgentInput,
    runMessages: Message[],
    subscriber: Subscriber<ProcessedEvent>
  ): void {
    if (runMessages.length > 0) {
      subscriber.next({
        type: EventType.MESSAGES_SNAPSHOT,
        messages: [...(input.messages ?? []), ...runMessages],
      });
    }
  }

  private async drainGenerator(
    events: AsyncGenerator<ThreadEvent>,
    traceContext: TraceContext
  ): Promise<void> {
    for await (const event of events) {
      this.trace("sdk.codex.output", event, traceContext);
      if (
        event.type === "error" &&
        !RETRYABLE_ERROR_RE.test(event.message)
      ) {
        throw new Error(event.message);
      }
      if (event.type === "turn.failed") {
        throw new Error(event.error.message);
      }
    }
  }

  // ─── Item event dispatcher ────────────────────────────────────────────────

  private handleItemEvent(
    phase: "item.started" | "item.updated" | "item.completed",
    item: ThreadItem,
    threadId: string,
    runId: string,
    subscriber: Subscriber<ProcessedEvent>,
    textTracker: Map<string, string>,
    activeAgentMessageIds: string[],
    toolTracker: Map<string, ToolState>,
    runMessages: Message[]
  ): void {
    if (item.type === "agent_message" || item.type === "reasoning") {
      this.handleTextItem(
        phase,
        item,
        threadId,
        runId,
        subscriber,
        textTracker,
        activeAgentMessageIds,
        runMessages
      );
    } else {
      this.handleToolItem(
        phase,
        item,
        threadId,
        runId,
        subscriber,
        activeAgentMessageIds.at(-1),
        toolTracker,
        runMessages
      );
    }
  }

  // ─── Text items (agent_message, reasoning) ────────────────────────────────

  private handleTextItem(
    phase: "item.started" | "item.updated" | "item.completed",
    item: Extract<ThreadItem, { type: "agent_message" | "reasoning" }>,
    threadId: string,
    runId: string,
    subscriber: Subscriber<ProcessedEvent>,
    textTracker: Map<string, string>,
    activeAgentMessageIds: string[],
    runMessages: Message[]
  ): void {
    // Prefix with runId so IDs stay unique across multi-turn runs
    // (Codex SDK resets item IDs to item_0, item_1, … on every run)
    const msgId = `${runId}-${item.id}`;

    // Open the stream on first sight
    if (!textTracker.has(item.id)) {
      textTracker.set(item.id, "");
      if (item.type === "agent_message") {
        activeAgentMessageIds.push(msgId);
        subscriber.next({
          type: EventType.TEXT_MESSAGE_START,
          threadId,
          runId,
          messageId: msgId,
          role: "assistant",
        });
      } else {
        subscriber.next({ type: EventType.REASONING_START, messageId: msgId });
        subscriber.next({
          type: EventType.REASONING_MESSAGE_START,
          messageId: msgId,
          role: "reasoning",
        });
      }
    }

    // Stream delta
    const prev = textTracker.get(item.id) ?? "";
    const delta = item.text.slice(prev.length);
    if (delta) {
      textTracker.set(item.id, item.text);
      if (item.type === "agent_message") {
        subscriber.next({
          type: EventType.TEXT_MESSAGE_CONTENT,
          threadId,
          runId,
          messageId: msgId,
          delta,
        });
      } else {
        subscriber.next({
          type: EventType.REASONING_MESSAGE_CONTENT,
          messageId: msgId,
          delta,
        });
      }
    }

    // Close on completion
    if (phase === "item.completed") {
      if (item.type === "agent_message") {
        subscriber.next({
          type: EventType.TEXT_MESSAGE_END,
          threadId,
          runId,
          messageId: msgId,
        });
        runMessages.push({ id: msgId, role: "assistant", content: item.text });
        const activeIdx = activeAgentMessageIds.indexOf(msgId);
        if (activeIdx !== -1) activeAgentMessageIds.splice(activeIdx, 1);
      } else {
        subscriber.next({
          type: EventType.REASONING_MESSAGE_END,
          messageId: msgId,
        });
        subscriber.next({ type: EventType.REASONING_END, messageId: msgId });
      }
      textTracker.delete(item.id);
    }
  }

  // ─── Tool-like items ──────────────────────────────────────────────────────

  private handleToolItem(
    phase: "item.started" | "item.updated" | "item.completed",
    item: Exclude<ThreadItem, { type: "agent_message" | "reasoning" }>,
    threadId: string,
    runId: string,
    subscriber: Subscriber<ProcessedEvent>,
    activeAgentMessageId: string | undefined,
    toolTracker: Map<string, ToolState>,
    runMessages: Message[]
  ): void {
    const descriptor = this.describeItem(item);
    // Prefix with runId so IDs stay unique across multi-turn runs
    const toolCallId = `${runId}-${item.id}`;

    // Open the tool call on first sight
    let state = toolTracker.get(item.id);
    if (!state) {
      state = { argsSent: false, ended: false };
      toolTracker.set(item.id, state);
      subscriber.next({
        type: EventType.TOOL_CALL_START,
        threadId,
        runId,
        toolCallId,
        toolCallName: descriptor.name,
        ...(activeAgentMessageId
          ? { parentMessageId: activeAgentMessageId }
          : {}),
      });
    }

    // Send args once when available
    if (!state.argsSent && descriptor.args !== undefined) {
      subscriber.next({
        type: EventType.TOOL_CALL_ARGS,
        threadId,
        runId,
        toolCallId,
        delta: this.stringify(descriptor.args),
      });
      state.argsSent = true;
    }

    if (phase !== "item.completed" || state.ended) return;

    // Emit result then close
    if (descriptor.result !== undefined) {
      const resultMsgId = `${toolCallId}-result`;
      subscriber.next({
        type: EventType.TOOL_CALL_RESULT,
        threadId,
        runId,
        messageId: resultMsgId,
        toolCallId,
        content: descriptor.result,
        role: "tool",
      });
      runMessages.push({
        id: resultMsgId,
        role: "tool",
        content: descriptor.result,
        toolCallId,
      });
    }

    subscriber.next({
      type: EventType.TOOL_CALL_END,
      threadId,
      runId,
      toolCallId,
    });
    state.ended = true;
  }

  /** Map each Codex item type to a canonical tool descriptor. */
  private describeItem(
    item: Exclude<ThreadItem, { type: "agent_message" | "reasoning" }>
  ): { name: string; args?: unknown; result?: string } {
    switch (item.type) {
      case "command_execution": {
        const cmd = item as CommandExecutionItem;
        return {
          name: "command_execution",
          args: { command: cmd.command },
          result:
            cmd.status === "in_progress"
              ? undefined
              : this.stringify({
                  status: cmd.status,
                  exitCode: cmd.exit_code,
                  output: cmd.aggregated_output,
                }),
        };
      }
      case "file_change": {
        const fc = item as FileChangeItem;
        return {
          name: "file_change",
          args: { changes: fc.changes },
          result: this.stringify({ status: fc.status, changes: fc.changes }),
        };
      }
      case "mcp_tool_call": {
        const mcp = item as McpToolCallItem;
        return {
          name: `${mcp.server}.${mcp.tool}`,
          args: mcp.arguments,
          result: mcp.error
            ? this.stringify({ error: mcp.error.message })
            : mcp.result
              ? this.stringify(mcp.result)
              : undefined,
        };
      }
      case "web_search": {
        const ws = item as WebSearchItem;
        return {
          name: "web_search",
          args: { query: ws.query },
          result: this.stringify({ query: ws.query }),
        };
      }
      case "todo_list": {
        const tl = item as TodoListItem;
        return {
          name: "todo_list",
          args: { items: tl.items },
          result: this.stringify({ items: tl.items }),
        };
      }
      case "error": {
        const err = item as ErrorItem;
        return {
          name: "codex_error",
          args: { message: err.message },
          result: err.message,
        };
      }
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private stringify(value: unknown): string {
    if (typeof value === "string") return value;
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }

  private async getCodexClient(
    input: RunAgentInput,
    traceContext: TraceContext
  ): Promise<CodexClientLike> {
    if (this.config.codexClient) return this.config.codexClient;
    // Dynamic import so CJS consumers can load this ESM-only package
    const { Codex } = await import("@openai/codex-sdk");
    const options = this.buildCodexOptions(input);
    this.trace("sdk.codex.input", {
      method: "new Codex",
      arguments: options,
    }, traceContext);
    return new Codex(options) as CodexClientLike;
  }

  private buildCodexOptions(input: RunAgentInput) {
    const { codexPathOverride, baseUrl, apiKey, env, config } = this.config;

    const configOverrides = { ...(config ?? {}) };
    const fp = (input.forwardedProps ?? {}) as Record<string, unknown>;
    if (
      ALLOWED_FORWARDED_PROPS.has("approvalsReviewer") &&
      (fp.approvalsReviewer === "user" || fp.approvalsReviewer === "auto_review")
    ) {
      configOverrides.approvals_reviewer = fp.approvalsReviewer;
    }

    const addendum = buildStateContextAddendum(input);
    const baseInstructions = this.config.instructions ?? "";
    const fullInstructions = [baseInstructions, addendum]
      .filter(Boolean)
      .join("\n\n");
    if (fullInstructions) {
      configOverrides.instructions = fullInstructions;
    }

    return {
      codexPathOverride,
      baseUrl,
      apiKey,
      env,
      config:
        Object.keys(configOverrides).length > 0 ? configOverrides : undefined,
    };
  }

  private buildThreadOptions(input: RunAgentInput): ThreadOptions {
    const fp = (input.forwardedProps ?? {}) as Record<string, unknown>;

    const pick = <T>(key: string, fallback: T | undefined): T | undefined =>
      ALLOWED_FORWARDED_PROPS.has(key) && fp[key] != null
        ? (fp[key] as T)
        : fallback;

    const threadOptions = {
      model: pick("model", this.config.model),
      sandboxMode: pick("sandboxMode", this.config.sandboxMode),
      workingDirectory: pick("workingDirectory", this.config.workingDirectory),
      skipGitRepoCheck: pick("skipGitRepoCheck", this.config.skipGitRepoCheck),
      modelReasoningEffort: pick(
        "modelReasoningEffort",
        this.config.modelReasoningEffort
      ),
      networkAccessEnabled: pick(
        "networkAccessEnabled",
        this.config.networkAccessEnabled
      ),
      webSearchMode: pick("webSearchMode", this.config.webSearchMode),
      webSearchEnabled: pick("webSearchEnabled", this.config.webSearchEnabled),
      approvalPolicy: pick("approvalPolicy", this.config.approvalPolicy),
      additionalDirectories: pick(
        "additionalDirectories",
        this.config.additionalDirectories
      ),
    };
    return threadOptions;
  }

  private trace(
    name: string,
    payload: unknown,
    context: TraceContext
  ): void {
    try {
      this.config.trace?.({
        name,
        payload,
        runId: context.runId,
        threadId: context.threadId,
      });
    } catch {
      // Tracing must never affect the agent stream.
    }
  }
}
