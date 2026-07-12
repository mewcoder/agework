import { describe, it, expect } from "vitest";
import { EventType } from "@ag-ui/client";
import { AppServerEventTranslator } from "./translator";
import type { TranslatorContext } from "./translator";

// ── Test helpers ────────────────────────────────────────────────────────────

const CTX: TranslatorContext = {
  threadId: "thr_test",
  runId: "run_test",
};

function makeTranslator() {
  return new AppServerEventTranslator();
}

function translate(
  t: AppServerEventTranslator,
  method: string,
  params: Record<string, unknown>,
) {
  return t.translate(method, params, CTX);
}

function types(events: Array<Record<string, unknown>>): string[] {
  return events.map((e) => e.type as string);
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("AppServerEventTranslator", () => {
  // ── Turn lifecycle (§10.1) ──────────────────────────────────────────────

  describe("Turn lifecycle", () => {
    it("turn/started does not emit RUN_STARTED (adapter emits it)", () => {
      const t = makeTranslator();
      const { events } = translate(t, "turn/started", {
        threadId: CTX.threadId,
        turn: { id: "turn_1", status: "inProgress" },
      });

      // The adapter emits RUN_STARTED before calling turn/start.
      // The translator must NOT duplicate it — doing so causes
      // "Cannot send RUN_STARTED while a run is still active".
      expect(events).toEqual([]);
    });

    it("turn/completed(status=completed) emits RUN_FINISHED", () => {
      const t = makeTranslator();
      translate(t, "turn/started", {
        threadId: CTX.threadId,
        turn: { id: "turn_1", status: "inProgress" },
      });

      const { events, terminal } = translate(t, "turn/completed", {
        threadId: CTX.threadId,
        turn: { id: "turn_1", status: "completed" },
      });

      expect(terminal).toBe(true);
      expect(types(events)).toContain(EventType.RUN_FINISHED);
    });

    it("turn/completed(status=interrupted) emits RUN_FINISHED with interrupt outcome", () => {
      const t = makeTranslator();
      translate(t, "turn/started", {
        threadId: CTX.threadId,
        turn: { id: "turn_1", status: "inProgress" },
      });

      const { events, terminal } = translate(t, "turn/completed", {
        threadId: CTX.threadId,
        turn: { id: "turn_1", status: "interrupted" },
      });

      expect(terminal).toBe(true);
      const finished = events.find((e) => e.type === EventType.RUN_FINISHED);
      expect(finished).toBeDefined();
      expect(finished!.outcome).toEqual({ type: "interrupt" });
    });

    it("turn/completed(status=failed) emits RUN_ERROR with turn.error", () => {
      const t = makeTranslator();
      translate(t, "turn/started", {
        threadId: CTX.threadId,
        turn: { id: "turn_1", status: "inProgress" },
      });

      const { events, terminal } = translate(t, "turn/completed", {
        threadId: CTX.threadId,
        turn: {
          id: "turn_1",
          status: "failed",
          error: { message: "API timeout", codexErrorInfo: null, additionalDetails: null },
        },
      });

      expect(terminal).toBe(true);
      const error = events.find((e) => e.type === EventType.RUN_ERROR);
      expect(error).toBeDefined();
      expect(error!.message).toBe("API timeout");
    });

    it("error notification does NOT produce terminal event (决策5)", () => {
      const t = makeTranslator();
      translate(t, "turn/started", {
        threadId: CTX.threadId,
        turn: { id: "turn_1", status: "inProgress" },
      });

      const { events, terminal, errorCandidate } = translate(t, "error", {
        threadId: CTX.threadId,
        turnId: "turn_1",
        error: { message: "rate limited", codexErrorInfo: null, additionalDetails: null },
        willRetry: true,
      });

      expect(terminal).toBe(false);
      expect(errorCandidate).toBe(true);
      expect(events).toEqual([]);
    });

    it("error notification sets failure candidate used by process exit", () => {
      const t = makeTranslator();
      translate(t, "turn/started", {
        threadId: CTX.threadId,
        turn: { id: "turn_1", status: "inProgress" },
      });

      translate(t, "error", {
        threadId: CTX.threadId,
        turnId: "turn_1",
        error: { message: "connection lost", codexErrorInfo: null, additionalDetails: null },
        willRetry: false,
      });

      const { events, terminal } = t.translateProcessExit(CTX);
      expect(terminal).toBe(true);
      const error = events.find((e) => e.type === EventType.RUN_ERROR);
      expect(error).toBeDefined();
      expect(error!.message).toBe("connection lost");
    });

    it("process exit without error notification uses 'process_exited'", () => {
      const t = makeTranslator();
      translate(t, "turn/started", {
        threadId: CTX.threadId,
        turn: { id: "turn_1", status: "inProgress" },
      });

      const { events, terminal } = t.translateProcessExit(CTX);
      expect(terminal).toBe(true);
      const error = events.find((e) => e.type === EventType.RUN_ERROR);
      expect(error!.message).toBe("process_exited");
    });

    it("late error/warning after terminal is swallowed", () => {
      const t = makeTranslator();
      translate(t, "turn/started", {
        threadId: CTX.threadId,
        turn: { id: "turn_1", status: "inProgress" },
      });
      translate(t, "turn/completed", {
        threadId: CTX.threadId,
        turn: { id: "turn_1", status: "completed" },
      });

      const { events, terminal } = translate(t, "error", {
        threadId: CTX.threadId,
        turnId: "turn_1",
        error: { message: "late error", codexErrorInfo: null, additionalDetails: null },
        willRetry: false,
      });

      expect(events).toEqual([]);
      expect(terminal).toBe(false);
    });

    it("closes hanging events before terminal (Start-End pairing)", () => {
      const t = makeTranslator();
      translate(t, "turn/started", {
        threadId: CTX.threadId,
        turn: { id: "turn_1", status: "inProgress" },
      });

      // Start a text message but don't complete it
      translate(t, "item/started", {
        threadId: CTX.threadId,
        turnId: "turn_1",
        item: { type: "agentMessage", id: "msg_1", text: "", phase: null, memoryCitation: null },
      });

      const { events } = translate(t, "turn/completed", {
        threadId: CTX.threadId,
        turn: { id: "turn_1", status: "completed" },
      });

      // Should have TEXT_MESSAGE_END before RUN_FINISHED
      const textEnd = events.find((e) => e.type === EventType.TEXT_MESSAGE_END);
      const runFinished = events.find((e) => e.type === EventType.RUN_FINISHED);
      expect(textEnd).toBeDefined();
      expect(runFinished).toBeDefined();
      expect(events.indexOf(textEnd!)).toBeLessThan(events.indexOf(runFinished!));
    });
  });

  // ── Agent Message (§10.2) ───────────────────────────────────────────────

  describe("Agent Message", () => {
    it("item/started(agentMessage) emits TEXT_MESSAGE_START", () => {
      const t = makeTranslator();
      translate(t, "turn/started", {
        threadId: CTX.threadId,
        turn: { id: "turn_1", status: "inProgress" },
      });

      const { events } = translate(t, "item/started", {
        threadId: CTX.threadId,
        turnId: "turn_1",
        item: { type: "agentMessage", id: "msg_1", text: "", phase: null, memoryCitation: null },
      });

      expect(types(events)).toEqual([EventType.TEXT_MESSAGE_START]);
      expect(events[0].messageId).toBe("run_test-msg_1");
      expect(events[0].role).toBe("assistant");
    });

    it("item/agentMessage/delta emits TEXT_MESSAGE_CONTENT", () => {
      const t = makeTranslator();
      translate(t, "turn/started", {
        threadId: CTX.threadId,
        turn: { id: "turn_1", status: "inProgress" },
      });
      translate(t, "item/started", {
        threadId: CTX.threadId,
        turnId: "turn_1",
        item: { type: "agentMessage", id: "msg_1", text: "", phase: null, memoryCitation: null },
      });

      const { events } = translate(t, "item/agentMessage/delta", {
        threadId: CTX.threadId,
        turnId: "turn_1",
        itemId: "msg_1",
        delta: "Hello ",
      });

      expect(types(events)).toEqual([EventType.TEXT_MESSAGE_CONTENT]);
      expect(events[0].delta).toBe("Hello ");
    });

    it("item/completed(agentMessage) finalizes text and emits TEXT_MESSAGE_END", () => {
      const t = makeTranslator();
      translate(t, "turn/started", {
        threadId: CTX.threadId,
        turn: { id: "turn_1", status: "inProgress" },
      });
      translate(t, "item/started", {
        threadId: CTX.threadId,
        turnId: "turn_1",
        item: { type: "agentMessage", id: "msg_1", text: "", phase: null, memoryCitation: null },
      });
      translate(t, "item/agentMessage/delta", {
        threadId: CTX.threadId,
        turnId: "turn_1",
        itemId: "msg_1",
        delta: "Hello",
      });

      const { events } = translate(t, "item/completed", {
        threadId: CTX.threadId,
        turnId: "turn_1",
        item: { type: "agentMessage", id: "msg_1", text: "Hello world", phase: "final_answer", memoryCitation: null },
      });

      // Should emit remaining delta " world" + TEXT_MESSAGE_END
      expect(types(events)).toEqual([EventType.TEXT_MESSAGE_CONTENT, EventType.TEXT_MESSAGE_END]);
      expect(events[0].delta).toBe(" world");
    });

    it("commentary phase is not added to runMessages", () => {
      const t = makeTranslator();
      translate(t, "turn/started", {
        threadId: CTX.threadId,
        turn: { id: "turn_1", status: "inProgress" },
      });
      translate(t, "item/started", {
        threadId: CTX.threadId,
        turnId: "turn_1",
        item: { type: "agentMessage", id: "msg_1", text: "", phase: null, memoryCitation: null },
      });

      translate(t, "item/completed", {
        threadId: CTX.threadId,
        turnId: "turn_1",
        item: { type: "agentMessage", id: "msg_1", text: "thinking...", phase: "commentary", memoryCitation: null },
      });

      expect(t.messages).toEqual([]);
    });

    it("final_answer phase is added to runMessages", () => {
      const t = makeTranslator();
      translate(t, "turn/started", {
        threadId: CTX.threadId,
        turn: { id: "turn_1", status: "inProgress" },
      });
      translate(t, "item/started", {
        threadId: CTX.threadId,
        turnId: "turn_1",
        item: { type: "agentMessage", id: "msg_1", text: "", phase: null, memoryCitation: null },
      });

      translate(t, "item/completed", {
        threadId: CTX.threadId,
        turnId: "turn_1",
        item: { type: "agentMessage", id: "msg_1", text: "The answer is 42", phase: "final_answer", memoryCitation: null },
      });

      expect(t.messages).toHaveLength(1);
      expect(t.messages[0].content).toBe("The answer is 42");
      expect(t.messages[0].role).toBe("assistant");
    });
  });

  // ── Reasoning (§10.3) ───────────────────────────────────────────────────

  describe("Reasoning", () => {
    it("item/started(reasoning) emits REASONING_START + REASONING_MESSAGE_START", () => {
      const t = makeTranslator();
      translate(t, "turn/started", {
        threadId: CTX.threadId,
        turn: { id: "turn_1", status: "inProgress" },
      });

      const { events } = translate(t, "item/started", {
        threadId: CTX.threadId,
        turnId: "turn_1",
        item: { type: "reasoning", id: "rea_1", summary: [], content: [] },
      });

      expect(types(events)).toEqual([
        EventType.REASONING_START,
        EventType.REASONING_MESSAGE_START,
      ]);
    });

    it("item/reasoning/summaryTextDelta emits REASONING_MESSAGE_CONTENT", () => {
      const t = makeTranslator();
      translate(t, "turn/started", {
        threadId: CTX.threadId,
        turn: { id: "turn_1", status: "inProgress" },
      });
      translate(t, "item/started", {
        threadId: CTX.threadId,
        turnId: "turn_1",
        item: { type: "reasoning", id: "rea_1", summary: [], content: [] },
      });

      const { events } = translate(t, "item/reasoning/summaryTextDelta", {
        threadId: CTX.threadId,
        turnId: "turn_1",
        itemId: "rea_1",
        delta: "I need to think...",
        summaryIndex: 0,
      });

      expect(types(events)).toEqual([EventType.REASONING_MESSAGE_CONTENT]);
      expect(events[0].delta).toBe("I need to think...");
    });

    it("item/completed(reasoning) flushes summary text and emits END events", () => {
      const t = makeTranslator();
      translate(t, "turn/started", {
        threadId: CTX.threadId,
        turn: { id: "turn_1", status: "inProgress" },
      });
      translate(t, "item/started", {
        threadId: CTX.threadId,
        turnId: "turn_1",
        item: { type: "reasoning", id: "rea_1", summary: [], content: [] },
      });

      const { events } = translate(t, "item/completed", {
        threadId: CTX.threadId,
        turnId: "turn_1",
        item: { type: "reasoning", id: "rea_1", summary: ["I thought about it"], content: [] },
      });

      // Should flush summary text as CONTENT, then emit END events
      expect(types(events)).toEqual([
        EventType.REASONING_MESSAGE_CONTENT,
        EventType.REASONING_MESSAGE_END,
        EventType.REASONING_END,
      ]);
      expect(events[0].delta).toBe("I thought about it");
    });

    it("item/completed(reasoning) does not flush if deltas were already streamed", () => {
      const t = makeTranslator();
      translate(t, "turn/started", {
        threadId: CTX.threadId,
        turn: { id: "turn_1", status: "inProgress" },
      });
      translate(t, "item/started", {
        threadId: CTX.threadId,
        turnId: "turn_1",
        item: { type: "reasoning", id: "rea_1", summary: [], content: [] },
      });
      // Stream some deltas
      translate(t, "item/reasoning/summaryTextDelta", {
        threadId: CTX.threadId,
        turnId: "turn_1",
        itemId: "rea_1",
        delta: "Already streamed",
        summaryIndex: 0,
      });

      const { events } = translate(t, "item/completed", {
        threadId: CTX.threadId,
        turnId: "turn_1",
        item: { type: "reasoning", id: "rea_1", summary: ["Already streamed"], content: [] },
      });

      // Should NOT emit CONTENT (deltas were already streamed)
      expect(types(events)).toEqual([
        EventType.REASONING_MESSAGE_END,
        EventType.REASONING_END,
      ]);
    });
  });

  // ── Command Execution (§10.4) ───────────────────────────────────────────

  describe("Command Execution", () => {
    it("item/started(commandExecution) emits TOOL_CALL_START + TOOL_CALL_ARGS", () => {
      const t = makeTranslator();
      translate(t, "turn/started", {
        threadId: CTX.threadId,
        turn: { id: "turn_1", status: "inProgress" },
      });

      const { events } = translate(t, "item/started", {
        threadId: CTX.threadId,
        turnId: "turn_1",
        item: {
          type: "commandExecution",
          id: "cmd_1",
          command: "ls -la",
          cwd: "/tmp",
          processId: null,
          source: "shell",
          status: "inProgress",
          commandActions: [],
          aggregatedOutput: null,
          exitCode: null,
          durationMs: null,
        },
      });

      expect(types(events)).toEqual([
        EventType.TOOL_CALL_START,
        EventType.TOOL_CALL_ARGS,
      ]);
      expect(events[0].toolCallName).toBe("command_execution");
      expect(events[1].delta).toContain("ls -la");
    });

    it("item/commandExecution/outputDelta emits Custom event", () => {
      const t = makeTranslator();
      translate(t, "turn/started", {
        threadId: CTX.threadId,
        turn: { id: "turn_1", status: "inProgress" },
      });
      translate(t, "item/started", {
        threadId: CTX.threadId,
        turnId: "turn_1",
        item: {
          type: "commandExecution",
          id: "cmd_1",
          command: "echo hi",
          cwd: "/tmp",
          processId: null,
          source: "shell",
          status: "inProgress",
          commandActions: [],
          aggregatedOutput: null,
          exitCode: null,
          durationMs: null,
        },
      });

      const { events } = translate(t, "item/commandExecution/outputDelta", {
        threadId: CTX.threadId,
        turnId: "turn_1",
        itemId: "cmd_1",
        delta: "hi\n",
      });

      expect(types(events)).toEqual([EventType.CUSTOM]);
      expect(events[0].name).toBe("command_output_delta");
    });

    it("item/completed(commandExecution) emits TOOL_CALL_RESULT + TOOL_CALL_END", () => {
      const t = makeTranslator();
      translate(t, "turn/started", {
        threadId: CTX.threadId,
        turn: { id: "turn_1", status: "inProgress" },
      });
      translate(t, "item/started", {
        threadId: CTX.threadId,
        turnId: "turn_1",
        item: {
          type: "commandExecution",
          id: "cmd_1",
          command: "echo hi",
          cwd: "/tmp",
          processId: null,
          source: "shell",
          status: "inProgress",
          commandActions: [],
          aggregatedOutput: null,
          exitCode: null,
          durationMs: null,
        },
      });

      const { events } = translate(t, "item/completed", {
        threadId: CTX.threadId,
        turnId: "turn_1",
        item: {
          type: "commandExecution",
          id: "cmd_1",
          command: "echo hi",
          cwd: "/tmp",
          processId: null,
          source: "shell",
          status: "completed",
          commandActions: [],
          aggregatedOutput: "hi\n",
          exitCode: 0,
          durationMs: 42,
        },
      });

      expect(types(events)).toEqual([
        EventType.TOOL_CALL_RESULT,
        EventType.TOOL_CALL_END,
      ]);
      expect(events[0].content).toContain("exitCode");
      expect(events[0].content).toContain("0");
    });
  });

  // ── File Change (§10.5) ─────────────────────────────────────────────────

  describe("File Change", () => {
    it("item/started(fileChange) emits TOOL_CALL_START(name=file_change)", () => {
      const t = makeTranslator();
      translate(t, "turn/started", {
        threadId: CTX.threadId,
        turn: { id: "turn_1", status: "inProgress" },
      });

      const { events } = translate(t, "item/started", {
        threadId: CTX.threadId,
        turnId: "turn_1",
        item: {
          type: "fileChange",
          id: "fc_1",
          changes: [{ path: "/tmp/test.ts", kind: { type: "add" }, diff: "+line" }],
          status: "inProgress",
        },
      });

      expect(types(events)).toEqual([
        EventType.TOOL_CALL_START,
        EventType.TOOL_CALL_ARGS,
      ]);
      expect(events[0].toolCallName).toBe("file_change");
    });

    it("turn/diff/updated emits Custom event", () => {
      const t = makeTranslator();
      translate(t, "turn/started", {
        threadId: CTX.threadId,
        turn: { id: "turn_1", status: "inProgress" },
      });

      const { events } = translate(t, "turn/diff/updated", {
        threadId: CTX.threadId,
        turnId: "turn_1",
        diff: "--- a/test.ts\n+++ b/test.ts\n",
      });

      expect(types(events)).toEqual([EventType.CUSTOM]);
      expect(events[0].name).toBe("turn_diff");
    });

    it("item/completed(fileChange) emits TOOL_CALL_RESULT + TOOL_CALL_END", () => {
      const t = makeTranslator();
      translate(t, "turn/started", {
        threadId: CTX.threadId,
        turn: { id: "turn_1", status: "inProgress" },
      });
      translate(t, "item/started", {
        threadId: CTX.threadId,
        turnId: "turn_1",
        item: {
          type: "fileChange",
          id: "fc_1",
          changes: [{ path: "/tmp/test.ts", kind: { type: "add" }, diff: "+line" }],
          status: "inProgress",
        },
      });

      const { events } = translate(t, "item/completed", {
        threadId: CTX.threadId,
        turnId: "turn_1",
        item: {
          type: "fileChange",
          id: "fc_1",
          changes: [{ path: "/tmp/test.ts", kind: { type: "add" }, diff: "+line" }],
          status: "completed",
        },
      });

      expect(types(events)).toEqual([
        EventType.TOOL_CALL_RESULT,
        EventType.TOOL_CALL_END,
      ]);
    });
  });

  // ── MCP Tool Call (§10.6) ───────────────────────────────────────────────

  describe("MCP Tool Call", () => {
    it("emits TOOL_CALL_START with server.tool name", () => {
      const t = makeTranslator();
      translate(t, "turn/started", {
        threadId: CTX.threadId,
        turn: { id: "turn_1", status: "inProgress" },
      });

      const { events } = translate(t, "item/started", {
        threadId: CTX.threadId,
        turnId: "turn_1",
        item: {
          type: "mcpToolCall",
          id: "mcp_1",
          server: "filesystem",
          tool: "read_file",
          status: "inProgress",
          arguments: { path: "/tmp/test.ts" },
          appContext: null,
          pluginId: null,
          result: null,
          error: null,
          durationMs: null,
        },
      });

      expect(events[0].toolCallName).toBe("filesystem.read_file");
    });

    it("completed with error emits error result", () => {
      const t = makeTranslator();
      translate(t, "turn/started", {
        threadId: CTX.threadId,
        turn: { id: "turn_1", status: "inProgress" },
      });
      translate(t, "item/started", {
        threadId: CTX.threadId,
        turnId: "turn_1",
        item: {
          type: "mcpToolCall",
          id: "mcp_1",
          server: "fs",
          tool: "read",
          status: "inProgress",
          arguments: {},
          appContext: null,
          pluginId: null,
          result: null,
          error: null,
          durationMs: null,
        },
      });

      const { events } = translate(t, "item/completed", {
        threadId: CTX.threadId,
        turnId: "turn_1",
        item: {
          type: "mcpToolCall",
          id: "mcp_1",
          server: "fs",
          tool: "read",
          status: "failed",
          arguments: {},
          appContext: null,
          pluginId: null,
          result: null,
          error: { message: "File not found" },
          durationMs: 10,
        },
      });

      const result = events.find((e) => e.type === EventType.TOOL_CALL_RESULT);
      expect(result).toBeDefined();
      expect(result!.content).toContain("File not found");
    });
  });

  // ── Other item types ────────────────────────────────────────────────────

  describe("Other item types", () => {
    it("dynamicToolCall emits with dynamic: prefix", () => {
      const t = makeTranslator();
      translate(t, "turn/started", {
        threadId: CTX.threadId,
        turn: { id: "turn_1", status: "inProgress" },
      });

      const { events } = translate(t, "item/started", {
        threadId: CTX.threadId,
        turnId: "turn_1",
        item: {
          type: "dynamicToolCall",
          id: "dyn_1",
          namespace: null,
          tool: "custom_search",
          arguments: { q: "test" },
          status: "inProgress",
          contentItems: null,
          success: null,
          durationMs: null,
        },
      });

      expect(events[0].toolCallName).toBe("dynamic:custom_search");
    });

    it("webSearch emits web_search tool name", () => {
      const t = makeTranslator();
      translate(t, "turn/started", {
        threadId: CTX.threadId,
        turn: { id: "turn_1", status: "inProgress" },
      });

      const { events } = translate(t, "item/started", {
        threadId: CTX.threadId,
        turnId: "turn_1",
        item: {
          type: "webSearch",
          id: "ws_1",
          query: "what is codex",
          action: null,
        },
      });

      expect(events[0].toolCallName).toBe("web_search");
    });

    it("enteredReviewMode emits review_started Custom event", () => {
      const t = makeTranslator();
      translate(t, "turn/started", {
        threadId: CTX.threadId,
        turn: { id: "turn_1", status: "inProgress" },
      });

      const { events } = translate(t, "item/started", {
        threadId: CTX.threadId,
        turnId: "turn_1",
        item: { type: "enteredReviewMode", id: "rev_1", review: "reviewing code" },
      });

      expect(types(events)).toEqual([EventType.CUSTOM]);
      expect(events[0].name).toBe("review_started");
    });

    it("contextCompaction emits context_compaction Custom event", () => {
      const t = makeTranslator();
      translate(t, "turn/started", {
        threadId: CTX.threadId,
        turn: { id: "turn_1", status: "inProgress" },
      });

      const { events } = translate(t, "item/started", {
        threadId: CTX.threadId,
        turnId: "turn_1",
        item: { type: "contextCompaction", id: "comp_1" },
      });

      expect(types(events)).toEqual([EventType.CUSTOM]);
      expect(events[0].name).toBe("context_compaction");
    });

    it("unknown item type does not fail and emits no events", () => {
      const t = makeTranslator();
      translate(t, "turn/started", {
        threadId: CTX.threadId,
        turn: { id: "turn_1", status: "inProgress" },
      });

      const { events } = translate(t, "item/started", {
        threadId: CTX.threadId,
        turnId: "turn_1",
        item: { type: "someUnknownType", id: "unk_1" },
      });

      expect(events).toEqual([]);
    });
  });

  // ── Plan / Usage (§10.7) ────────────────────────────────────────────────

  describe("Plan / Usage", () => {
    it("turn/plan/updated emits plan_updated Custom event", () => {
      const t = makeTranslator();
      translate(t, "turn/started", {
        threadId: CTX.threadId,
        turn: { id: "turn_1", status: "inProgress" },
      });

      const { events } = translate(t, "turn/plan/updated", {
        threadId: CTX.threadId,
        turnId: "turn_1",
        explanation: "I will do X then Y",
        plan: [
          { step: "Do X", status: "inProgress" },
          { step: "Do Y", status: "pending" },
        ],
      });

      expect(types(events)).toEqual([EventType.CUSTOM]);
      expect(events[0].name).toBe("plan_updated");
    });

    it("thread/tokenUsage/updated emits token_usage Custom event", () => {
      const t = makeTranslator();
      translate(t, "turn/started", {
        threadId: CTX.threadId,
        turn: { id: "turn_1", status: "inProgress" },
      });

      const { events } = translate(t, "thread/tokenUsage/updated", {
        threadId: CTX.threadId,
        turnId: "turn_1",
        tokenUsage: {
          total: {
            totalTokens: 1000,
            inputTokens: 800,
            cachedInputTokens: 200,
            outputTokens: 200,
            reasoningOutputTokens: 50,
          },
          last: {
            totalTokens: 500,
            inputTokens: 400,
            cachedInputTokens: 100,
            outputTokens: 100,
            reasoningOutputTokens: 25,
          },
          modelContextWindow: 128000,
        },
      });

      expect(types(events)).toEqual([EventType.CUSTOM]);
      expect(events[0].name).toBe("token_usage");
    });
  });

  // ── Start-End balance ───────────────────────────────────────────────────

  describe("Start-End balance", () => {
    it("a complete basic turn produces balanced events", () => {
      const t = makeTranslator();
      const allEvents: Array<Record<string, unknown>> = [];

      // Turn start
      allEvents.push(
        ...translate(t, "turn/started", {
          threadId: CTX.threadId,
          turn: { id: "turn_1", status: "inProgress" },
        }).events,
      );

      // Agent message
      allEvents.push(
        ...translate(t, "item/started", {
          threadId: CTX.threadId,
          turnId: "turn_1",
          item: { type: "agentMessage", id: "msg_1", text: "", phase: null, memoryCitation: null },
        }).events,
      );

      allEvents.push(
        ...translate(t, "item/agentMessage/delta", {
          threadId: CTX.threadId,
          turnId: "turn_1",
          itemId: "msg_1",
          delta: "Hello!",
        }).events,
      );

      allEvents.push(
        ...translate(t, "item/completed", {
          threadId: CTX.threadId,
          turnId: "turn_1",
          item: { type: "agentMessage", id: "msg_1", text: "Hello!", phase: "final_answer", memoryCitation: null },
        }).events,
      );

      // Turn completed
      allEvents.push(
        ...translate(t, "turn/completed", {
          threadId: CTX.threadId,
          turn: { id: "turn_1", status: "completed" },
        }).events,
      );

      // Verify Start-End balance
      const starts = allEvents.filter(
        (e) =>
          e.type === EventType.TEXT_MESSAGE_START ||
          e.type === EventType.TOOL_CALL_START ||
          e.type === EventType.REASONING_START,
      ).length;
      const ends = allEvents.filter(
        (e) =>
          e.type === EventType.TEXT_MESSAGE_END ||
          e.type === EventType.TOOL_CALL_END ||
          e.type === EventType.REASONING_END,
      ).length;

      expect(starts).toBe(1); // TEXT_MESSAGE_START
      expect(ends).toBe(1); // TEXT_MESSAGE_END

      // Verify terminal is last
      const lastEvent = allEvents[allEvents.length - 1];
      expect(lastEvent.type).toBe(EventType.RUN_FINISHED);
    });

    it("a turn with command execution produces balanced tool events", () => {
      const t = makeTranslator();
      const allEvents: Array<Record<string, unknown>> = [];

      allEvents.push(
        ...translate(t, "turn/started", {
          threadId: CTX.threadId,
          turn: { id: "turn_1", status: "inProgress" },
        }).events,
      );

      allEvents.push(
        ...translate(t, "item/started", {
          threadId: CTX.threadId,
          turnId: "turn_1",
          item: {
            type: "commandExecution",
            id: "cmd_1",
            command: "echo test",
            cwd: "/tmp",
            processId: null,
            source: "shell",
            status: "inProgress",
            commandActions: [],
            aggregatedOutput: null,
            exitCode: null,
            durationMs: null,
          },
        }).events,
      );

      allEvents.push(
        ...translate(t, "item/completed", {
          threadId: CTX.threadId,
          turnId: "turn_1",
          item: {
            type: "commandExecution",
            id: "cmd_1",
            command: "echo test",
            cwd: "/tmp",
            processId: null,
            source: "shell",
            status: "completed",
            commandActions: [],
            aggregatedOutput: "test\n",
            exitCode: 0,
            durationMs: 10,
          },
        }).events,
      );

      allEvents.push(
        ...translate(t, "turn/completed", {
          threadId: CTX.threadId,
          turn: { id: "turn_1", status: "completed" },
        }).events,
      );

      const toolStarts = allEvents.filter((e) => e.type === EventType.TOOL_CALL_START).length;
      const toolEnds = allEvents.filter((e) => e.type === EventType.TOOL_CALL_END).length;

      expect(toolStarts).toBe(1);
      expect(toolEnds).toBe(1);
    });
  });

  // ── MESSAGES_SNAPSHOT ───────────────────────────────────────────────────

  describe("MESSAGES_SNAPSHOT", () => {
    it("emits MESSAGES_SNAPSHOT on turn/completed with accumulated messages", () => {
      const t = makeTranslator();
      translate(t, "turn/started", {
        threadId: CTX.threadId,
        turn: { id: "turn_1", status: "inProgress" },
      });

      // Complete an agent message
      translate(t, "item/started", {
        threadId: CTX.threadId,
        turnId: "turn_1",
        item: { type: "agentMessage", id: "msg_1", text: "", phase: null, memoryCitation: null },
      });
      translate(t, "item/completed", {
        threadId: CTX.threadId,
        turnId: "turn_1",
        item: { type: "agentMessage", id: "msg_1", text: "Final answer", phase: "final_answer", memoryCitation: null },
      });

      const { events } = translate(t, "turn/completed", {
        threadId: CTX.threadId,
        turn: { id: "turn_1", status: "completed" },
      });

      const snapshot = events.find((e) => e.type === EventType.MESSAGES_SNAPSHOT);
      expect(snapshot).toBeDefined();
      const messages = snapshot!.messages as Array<{ content: string; role: string }>;
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe("Final answer");
      expect(messages[0].role).toBe("assistant");
    });
  });
});
