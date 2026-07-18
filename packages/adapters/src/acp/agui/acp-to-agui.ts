import { EventType } from "@ag-ui/client";
import type {
  RunStartedEvent,
  RunFinishedEvent,
  RunErrorEvent,
  TextMessageStartEvent,
  TextMessageContentEvent,
  TextMessageEndEvent,
  ToolCallStartEvent,
  ToolCallArgsEvent,
  ToolCallResultEvent,
  ToolCallEndEvent,
  ReasoningStartEvent,
  ReasoningMessageStartEvent,
  ReasoningMessageContentEvent,
  ReasoningMessageEndEvent,
  ReasoningEndEvent,
  CustomEvent,
  Message,
} from "@ag-ui/core";
import type {
  ContentBlock,
  ToolCall,
  ToolCallStatus,
  ToolCallContent,
  ToolCallUpdate,
} from "@agentclientprotocol/sdk";
import type { AcpSessionUpdate } from "../client/acp-client";
import { contentBlockText } from "./content";
import { acpToolName, toolArgs, toolResult } from "./tools";

/** Every AG-UI event the mapper can emit. */
export type AcpAguiEvent =
  | RunStartedEvent
  | RunFinishedEvent
  | RunErrorEvent
  | TextMessageStartEvent
  | TextMessageContentEvent
  | TextMessageEndEvent
  | ToolCallStartEvent
  | ToolCallArgsEvent
  | ToolCallResultEvent
  | ToolCallEndEvent
  | ReasoningStartEvent
  | ReasoningMessageStartEvent
  | ReasoningMessageContentEvent
  | ReasoningMessageEndEvent
  | ReasoningEndEvent
  | CustomEvent;

export type AcpMapperOptions = {
  threadId: string;
  runId: string;
  emit: (event: AcpAguiEvent) => void;
  trace?: (name: string, payload: unknown) => void;
};

/** Context-window usage reported via `usage_update` (used/total tokens of the window). */
export type AcpContextUsage = {
  used: number;
  size: number;
  cost?: unknown;
};

type ToolEntry = {
  started: boolean;
  argsSent: boolean;
  ended: boolean;
  /** Stable AG-UI id; an interrupted tool keeps it across resumed runs. */
  aguiToolCallId?: string;
  /** The interrupt closed this tool; resume should only append its result. */
  closedForInterrupt?: boolean;
  title?: string | null;
  kind?: string | null;
  eligibleToStart?: boolean;
  pendingArgs?: {
    title?: string | null;
    kind?: string | null;
    rawInput?: unknown;
  };
  pendingCompletion?: {
    status: "completed" | "failed";
    content: ToolCallContent[] | null | undefined;
    rawOutput: unknown;
  };
};

/**
 * Pure translation layer: ACP `session/update` notifications → AG-UI events. It
 * holds only per-turn streaming state (open messages/tools); it never spawns
 * processes, talks to the server, or persists anything (doc §3.2). Run boundary
 * events (RUN_STARTED/FINISHED) are the adapter's responsibility.
 */
export class AcpToAguiMapper {
  private readonly threadId: string;
  private runId: string;
  private readonly emit: (event: AcpAguiEvent) => void;
  private readonly trace?: (name: string, payload: unknown) => void;

  private openText?: string;
  private openTextAcpId?: string;
  private textBuffer = "";
  /** Number of text segments seen for each ACP message id. */
  private readonly textSegmentCounts = new Map<string, number>();
  private openReasoning?: string;
  private msgCounter = 0;
  private reasonCounter = 0;
  private readonly tools = new Map<string, ToolEntry>();
  private readonly runMessages: Message[] = [];
  private contextUsage?: AcpContextUsage;
  /** New tool starts arriving after RUN_FINISHED(interrupt) wait for resume. */
  private deferToolStarts = false;

  constructor(opts: AcpMapperOptions) {
    this.threadId = opts.threadId;
    this.runId = opts.runId;
    this.emit = opts.emit;
    this.trace = opts.trace;
  }

  /** Assistant/tool messages accumulated this turn (for a MESSAGES_SNAPSHOT). */
  getMessages(): Message[] {
    return this.runMessages;
  }

  /** Re-point subsequent events at a new runId (after an interrupt/resume). */
  setRunId(runId: string): void {
    this.runId = runId;
  }

  /** Resume deferred tool lifecycle events after RUN_STARTED has been emitted. */
  resume(): void {
    this.deferToolStarts = false;
    for (const [acpId, entry] of this.tools) {
      if (!entry.started && entry.eligibleToStart) {
        this.startTool(acpId, entry);
        if (entry.pendingArgs) {
          this.maybeSendArgs(acpId, entry, entry.pendingArgs);
          entry.pendingArgs = undefined;
        }
      }
      if (entry.pendingCompletion && entry.started && !entry.ended) {
        const completion = entry.pendingCompletion;
        entry.pendingCompletion = undefined;
        this.maybeCompleteTool(
          acpId,
          entry,
          completion.status,
          completion.content,
          completion.rawOutput
        );
      }
    }
  }

  /** Latest context-window usage seen, if any. */
  getContextUsage(): AcpContextUsage | undefined {
    return this.contextUsage;
  }

  /** Translate a single ACP session update into AG-UI events. */
  handle(update: AcpSessionUpdate): void {
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        this.handleAgentMessage(update.content, update.messageId);
        break;
      case "agent_thought_chunk":
        this.handleThought(update.content);
        break;
      case "user_message_chunk":
        // User messages are already persisted by the frontend (doc §12.4).
        this.trace?.("sdk.acp.user_message_chunk", update);
        break;
      case "tool_call":
        this.handleToolCall(update);
        break;
      case "tool_call_update":
        this.handleToolCallUpdate(update);
        break;
      case "plan":
        this.emitCustom("acp.plan", { entries: update.entries });
        break;
      case "plan_update":
        this.emitCustom("acp.plan", { plan: update.plan });
        break;
      case "available_commands_update":
        this.emitCustom("acp.commands.updated", {
          availableCommands: update.availableCommands,
        });
        break;
      case "config_option_update":
        this.emitCustom("acp.config.updated", {
          configOptions: update.configOptions,
        });
        break;
      case "current_mode_update":
        this.emitCustom("acp.mode.updated", {
          currentModeId: update.currentModeId,
        });
        break;
      case "usage_update":
        this.contextUsage = {
          used: update.used,
          size: update.size,
          cost: update.cost ?? undefined,
        };
        this.trace?.("sdk.acp.usage_update", update);
        break;
      default:
        // Unknown/experimental update: trace, never crash (doc §25).
        this.trace?.("sdk.acp.unknown_update", update);
        break;
    }
  }

  /**
   * Close open text/reasoning streams (e.g. before a mid-turn interrupt's
   * RUN_FINISHED, which AG-UI forbids while a text message is active), leaving
   * tool calls open to resume.
   */
  closeMessages(): void {
    this.deferToolStarts = true;
    this.closeText();
    this.closeReasoning();
    for (const entry of this.tools.values()) {
      if (entry.started && !entry.ended && !entry.closedForInterrupt) {
        this.emit({
          type: EventType.TOOL_CALL_END,
          threadId: this.threadId,
          runId: this.runId,
          toolCallId: entry.aguiToolCallId!,
        });
        entry.closedForInterrupt = true;
      }
    }
  }

  /** Close any open message/tool state at the end of a prompt turn. */
  finalize(): void {
    this.closeText();
    this.closeReasoning();
    for (const [acpId, entry] of this.tools) {
      if (entry.started && !entry.ended && !entry.closedForInterrupt) {
        this.emit({
          type: EventType.TOOL_CALL_END,
          threadId: this.threadId,
          runId: this.runId,
          toolCallId: this.toolCallId(acpId, entry),
        });
        entry.ended = true;
        this.trace?.("sdk.acp.tool_incomplete", { toolCallId: acpId });
      }
    }
  }

  // ── Text (agent_message_chunk) ──────────────────────────────────────────────

  private handleAgentMessage(
    content: ContentBlock,
    messageId?: string | null
  ): void {
    this.closeReasoning();
    const acpId = messageId ?? undefined;

    // A changed ACP messageId means a new assistant message.
    if (
      this.openText &&
      acpId !== undefined &&
      this.openTextAcpId !== undefined &&
      this.openTextAcpId !== acpId
    ) {
      this.closeText();
    }

    if (!this.openText) {
      this.openText = this.nextTextMessageId(acpId);
      this.openTextAcpId = acpId;
      this.emit({
        type: EventType.TEXT_MESSAGE_START,
        threadId: this.threadId,
        runId: this.runId,
        messageId: this.openText,
        role: "assistant",
      });
    }

    const delta = contentBlockText(content);
    if (delta) {
      this.textBuffer += delta;
      this.emit({
        type: EventType.TEXT_MESSAGE_CONTENT,
        threadId: this.threadId,
        runId: this.runId,
        messageId: this.openText,
        delta,
      });
    }
  }

  private nextTextMessageId(acpId?: string): string {
    if (acpId === undefined) {
      return `${this.runId}-msg-${++this.msgCounter}`;
    }
    const segment = (this.textSegmentCounts.get(acpId) ?? 0) + 1;
    this.textSegmentCounts.set(acpId, segment);
    return segment === 1
      ? `${this.runId}-${acpId}`
      : `${this.runId}-${acpId}-part-${segment}`;
  }

  private closeText(): void {
    if (!this.openText) return;
    this.emit({
      type: EventType.TEXT_MESSAGE_END,
      threadId: this.threadId,
      runId: this.runId,
      messageId: this.openText,
    });
    this.runMessages.push({
      id: this.openText,
      role: "assistant",
      content: this.textBuffer,
    });
    this.openText = undefined;
    this.openTextAcpId = undefined;
    this.textBuffer = "";
  }

  // ── Reasoning (agent_thought_chunk) ─────────────────────────────────────────

  private handleThought(content: ContentBlock): void {
    this.closeText();
    if (!this.openReasoning) {
      this.openReasoning = `${this.runId}-reason-${++this.reasonCounter}`;
      this.emit({
        type: EventType.REASONING_START,
        messageId: this.openReasoning,
      });
      this.emit({
        type: EventType.REASONING_MESSAGE_START,
        messageId: this.openReasoning,
        role: "reasoning",
      });
    }
    const delta = contentBlockText(content);
    if (delta) {
      this.emit({
        type: EventType.REASONING_MESSAGE_CONTENT,
        messageId: this.openReasoning,
        delta,
      });
    }
  }

  private closeReasoning(): void {
    if (!this.openReasoning) return;
    this.emit({
      type: EventType.REASONING_MESSAGE_END,
      messageId: this.openReasoning,
    });
    this.emit({
      type: EventType.REASONING_END,
      messageId: this.openReasoning,
    });
    this.openReasoning = undefined;
  }

  // ── Tool calls ──────────────────────────────────────────────────────────────

  private handleToolCall(tc: ToolCall): void {
    const entry = this.ensureTool(tc.toolCallId, tc.kind, tc.status, tc.title);
    this.maybeSendArgs(tc.toolCallId, entry, {
      title: tc.title ?? entry.title,
      kind: tc.kind,
      rawInput: tc.rawInput,
    });
    this.maybeCompleteTool(tc.toolCallId, entry, tc.status, tc.content, tc.rawOutput);
  }

  private handleToolCallUpdate(tu: ToolCallUpdate): void {
    const entry = this.ensureTool(tu.toolCallId, tu.kind, tu.status, tu.title);
    this.maybeSendArgs(tu.toolCallId, entry, {
      title: tu.title ?? entry.title,
      kind: tu.kind,
      rawInput: tu.rawInput,
    });
    this.maybeCompleteTool(tu.toolCallId, entry, tu.status, tu.content, tu.rawOutput);
  }

  private ensureTool(
    acpId: string,
    kind?: string | null,
    status?: ToolCallStatus | null,
    title?: string | null,
  ): ToolEntry {
    let entry = this.tools.get(acpId);
    if (!entry) {
      entry = { started: false, argsSent: false, ended: false };
      this.tools.set(acpId, entry);
    }
    if (title !== undefined) entry.title = title;
    if (kind !== undefined) entry.kind = kind;
    // pending = agent 还没真正执行这个工具,ACP 的 session/request_permission
    // 正好发生在这一刻。此时不能开 TOOL_CALL_START:AG-UI 禁止在有活跃 tool
    // call 时发 RUN_FINISHED,而权限中断要发的正是它。等 in_progress/completed
    // 再开,语义(未开始执行)和 AG-UI 约束一并满足。
    if (status === "pending") return entry;
    entry.eligibleToStart = true;
    if (!entry.started) {
      if (!this.deferToolStarts) this.startTool(acpId, entry);
    }
    return entry;
  }

  private maybeSendArgs(
    acpId: string,
    entry: ToolEntry,
    input: { title?: string | null; kind?: string | null; rawInput?: unknown }
  ): void {
    // START 未发时不能发 ARGS(AG-UI 要求 START→ARGS 顺序);pending 阶段的
    // 参数由后续 tool_call_update 带回,届时 START 已开。
    if (!entry.started) {
      entry.pendingArgs = input;
      return;
    }
    if (entry.argsSent) return;
    const hasArgs =
      input.rawInput !== undefined || input.title != null || input.kind != null;
    if (!hasArgs) return;
    this.emit({
      type: EventType.TOOL_CALL_ARGS,
      threadId: this.threadId,
      runId: this.runId,
      toolCallId: this.toolCallId(acpId, entry),
      delta: toolArgs(input as never),
    });
    entry.argsSent = true;
  }

  private maybeCompleteTool(
    acpId: string,
    entry: ToolEntry,
    status: ToolCallStatus | null | undefined,
    content: ToolCallContent[] | null | undefined,
    rawOutput: unknown
  ): void {
    if (entry.ended) return;
    if (status !== "completed" && status !== "failed") return;

    if (!entry.started) {
      entry.pendingCompletion = { status, content, rawOutput };
      return;
    }
    if (entry.closedForInterrupt && this.deferToolStarts) {
      entry.pendingCompletion = { status, content, rawOutput };
      return;
    }

    const toolCallId = this.toolCallId(acpId, entry);
    const resultMsgId = `${toolCallId}-result`;
    const result =
      status === "failed"
        ? toolResult({ content, rawOutput }) || "tool call failed"
        : toolResult({ content, rawOutput });

    this.emit({
      type: EventType.TOOL_CALL_RESULT,
      threadId: this.threadId,
      runId: this.runId,
      messageId: resultMsgId,
      toolCallId,
      content: result,
      role: "tool",
    });
    if (!entry.closedForInterrupt) {
      this.emit({
        type: EventType.TOOL_CALL_END,
        threadId: this.threadId,
        runId: this.runId,
        toolCallId,
      });
    }
    this.runMessages.push({
      id: resultMsgId,
      role: "tool",
      content: result,
      toolCallId,
    });
    entry.ended = true;
  }

  private startTool(acpId: string, entry: ToolEntry): void {
    if (entry.started) return;
    entry.aguiToolCallId = `${this.runId}-${acpId}`;
    // ACP implementations such as pi may reuse one messageId for the
    // pre-tool narration and the final answer. Close the current text before
    // opening the tool so the next agent_message_chunk becomes a new part.
    // Keep the old id as parentMessageId so the UI can still group the
    // pre-tool narration into the processing block.
    const parentMessageId = this.openText;
    if (parentMessageId) this.closeText();
    this.emit({
      type: EventType.TOOL_CALL_START,
      threadId: this.threadId,
      runId: this.runId,
      toolCallId: entry.aguiToolCallId,
      toolCallName: acpToolName(entry.kind as never),
      ...(parentMessageId ? { parentMessageId } : {}),
    });
    entry.started = true;
  }

  private toolCallId(acpId: string, entry: ToolEntry): string {
    return entry.aguiToolCallId ?? `${this.runId}-${acpId}`;
  }

  // ── Custom passthrough (plan / commands / config / mode) ─────────────────────

  private emitCustom(name: string, value: unknown): void {
    this.trace?.(`sdk.acp.${name}`, value);
    this.emit({ type: EventType.CUSTOM, name, value });
  }
}
