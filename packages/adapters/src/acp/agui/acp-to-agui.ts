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

type ToolEntry = { started: boolean; argsSent: boolean; ended: boolean };

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
  private openReasoning?: string;
  private msgCounter = 0;
  private reasonCounter = 0;
  private readonly tools = new Map<string, ToolEntry>();
  private readonly runMessages: Message[] = [];
  private contextUsage?: AcpContextUsage;

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
    this.closeText();
    this.closeReasoning();
  }

  /** Close any open message/tool state at the end of a prompt turn. */
  finalize(): void {
    this.closeText();
    this.closeReasoning();
    for (const [acpId, entry] of this.tools) {
      if (entry.started && !entry.ended) {
        this.emit({
          type: EventType.TOOL_CALL_END,
          threadId: this.threadId,
          runId: this.runId,
          toolCallId: `${this.runId}-${acpId}`,
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
      this.openText = `${this.runId}-${acpId ?? `msg-${++this.msgCounter}`}`;
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
    const entry = this.ensureTool(tc.toolCallId, tc.kind);
    this.maybeSendArgs(tc.toolCallId, entry, {
      title: tc.title,
      kind: tc.kind,
      rawInput: tc.rawInput,
    });
    this.maybeCompleteTool(tc.toolCallId, entry, tc.status, tc.content, tc.rawOutput);
  }

  private handleToolCallUpdate(tu: ToolCallUpdate): void {
    const entry = this.ensureTool(tu.toolCallId, tu.kind);
    this.maybeSendArgs(tu.toolCallId, entry, {
      title: tu.title,
      kind: tu.kind,
      rawInput: tu.rawInput,
    });
    this.maybeCompleteTool(tu.toolCallId, entry, tu.status, tu.content, tu.rawOutput);
  }

  private ensureTool(acpId: string, kind?: string | null): ToolEntry {
    let entry = this.tools.get(acpId);
    if (!entry) {
      entry = { started: false, argsSent: false, ended: false };
      this.tools.set(acpId, entry);
    }
    if (!entry.started) {
      this.emit({
        type: EventType.TOOL_CALL_START,
        threadId: this.threadId,
        runId: this.runId,
        toolCallId: `${this.runId}-${acpId}`,
        toolCallName: acpToolName(kind as never),
        ...(this.openText ? { parentMessageId: this.openText } : {}),
      });
      entry.started = true;
    }
    return entry;
  }

  private maybeSendArgs(
    acpId: string,
    entry: ToolEntry,
    input: { title?: string | null; kind?: string | null; rawInput?: unknown }
  ): void {
    if (entry.argsSent) return;
    const hasArgs =
      input.rawInput !== undefined || input.title != null || input.kind != null;
    if (!hasArgs) return;
    this.emit({
      type: EventType.TOOL_CALL_ARGS,
      threadId: this.threadId,
      runId: this.runId,
      toolCallId: `${this.runId}-${acpId}`,
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

    const toolCallId = `${this.runId}-${acpId}`;
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
    this.emit({
      type: EventType.TOOL_CALL_END,
      threadId: this.threadId,
      runId: this.runId,
      toolCallId,
    });
    this.runMessages.push({
      id: resultMsgId,
      role: "tool",
      content: result,
      toolCallId,
    });
    entry.ended = true;
  }

  // ── Custom passthrough (plan / commands / config / mode) ─────────────────────

  private emitCustom(name: string, value: unknown): void {
    this.trace?.(`sdk.acp.${name}`, value);
    this.emit({ type: EventType.CUSTOM, name, value });
  }
}
