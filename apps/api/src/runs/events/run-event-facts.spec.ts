import { describe, it, expect } from "vitest";
import { RunEventFacts, compactData } from "./run-event-facts";

describe("compactData", () => {
  it("removes undefined values", () => {
    expect(compactData({ a: "x", b: undefined })).toEqual({ a: "x" });
  });

  it("preserves null, string, number, boolean", () => {
    expect(compactData({ a: null, b: "s", c: 1, d: false })).toEqual({
      a: null,
      b: "s",
      c: 1,
      d: false,
    });
  });

  it("recursively handles arrays", () => {
    expect(compactData({ arr: [1, null, "two"] })).toEqual({
      arr: [1, null, "two"],
    });
  });

  it("recursively handles nested objects", () => {
    expect(compactData({ obj: { keep: "yes", drop: undefined } })).toEqual({
      obj: { keep: "yes" },
    });
  });

  it("converts non-JSON-safe types to string", () => {
    const result = compactData({ fn: () => {} });
    expect(typeof result.fn).toBe("string");
  });
});

describe("RunEventFacts", () => {
  describe("runCreated", () => {
    it("builds a run.created event", () => {
      const event = RunEventFacts.runCreated({
        runId: "run-1",
        conversationId: "conv-1",
        workspaceId: "ws-1",
        agentType: "claude",
        runtimeType: "local",
      });
      expect(event.type).toBe("run.created");
      expect(event.origin).toBe("platform");
      expect(event.targetType).toBe("run");
      expect(event.targetId).toBe("run-1");
      expect(event.refs).toEqual({ conversationId: "conv-1" });
      expect(event.data).toMatchObject({
        agentType: "claude",
        runtimeType: "local",
        workspaceId: "ws-1",
      });
    });

    it("includes isolationScope when provided", () => {
      const event = RunEventFacts.runCreated({
        runId: "run-1",
        conversationId: "conv-1",
        agentType: "claude",
        runtimeType: "sandbox",
        isolationScope: "workspace",
      });
      expect(event.data).toMatchObject({ isolationScope: "workspace" });
    });
  });

  describe("runStatusChanged", () => {
    it("builds a run.status_changed event", () => {
      const event = RunEventFacts.runStatusChanged({
        runId: "run-1",
        status: "running",
      });
      expect(event.type).toBe("run.status_changed");
      expect(event.origin).toBe("worker");
      expect(event.data).toMatchObject({ status: "running" });
    });

    it("uses custom origin", () => {
      const event = RunEventFacts.runStatusChanged({
        runId: "run-1",
        status: "error",
        origin: "platform",
        error: "crashed",
      });
      expect(event.origin).toBe("platform");
      expect(event.summary).toBe("crashed");
    });
  });

  describe("runtimeStatusChanged", () => {
    it("builds a runtime.status_changed event", () => {
      const event = RunEventFacts.runtimeStatusChanged({
        runId: "run-1",
        status: "started",
        runtimeType: "docker",
      });
      expect(event.type).toBe("runtime.status_changed");
      expect(event.targetType).toBe("runtime");
      expect(event.data).toMatchObject({
        status: "started",
        runtimeType: "docker",
      });
    });
  });

  describe("messageAccepted", () => {
    it("builds a message.accepted event", () => {
      const event = RunEventFacts.messageAccepted({
        runId: "run-1",
        messageId: "msg-1",
        conversationId: "conv-1",
      });
      expect(event.type).toBe("message.accepted");
      expect(event.targetType).toBe("message");
      expect(event.refs).toMatchObject({ messageId: "msg-1" });
    });
  });

  describe("commandSent", () => {
    it("builds a control.sent event", () => {
      const event = RunEventFacts.commandSent({
        runId: "run-1",
        commandId: "cmd-1",
        commandType: "cancel",
      });
      expect(event.type).toBe("control.sent");
      expect(event.summary).toBe("cancel sent");
    });
  });

  describe("controlHandled", () => {
    it("builds a control.handled event", () => {
      const event = RunEventFacts.controlHandled({
        runId: "run-1",
        commandId: "cmd-1",
        controlType: "cancel",
        phase: "handled",
      });
      expect(event.type).toBe("control.handled");
      expect(event.origin).toBe("worker");
    });
  });

  describe("controlFailed", () => {
    it("builds a control.failed event", () => {
      const event = RunEventFacts.controlFailed({
        runId: "run-1",
        commandId: "cmd-1",
        controlType: "cancel",
        error: "timeout",
      });
      expect(event.type).toBe("control.failed");
      expect(event.summary).toBe("timeout");
    });

    it("uses default summary when no error", () => {
      const event = RunEventFacts.controlFailed({
        runId: "run-1",
        commandId: "cmd-1",
        controlType: "cancel",
      });
      expect(event.summary).toBe("cancel failed");
    });
  });

  describe("messageStarted", () => {
    it("returns undefined when messageId is missing", () => {
      expect(RunEventFacts.messageStarted({ runId: "run-1" })).toBeUndefined();
    });

    it("builds event when messageId is provided", () => {
      const event = RunEventFacts.messageStarted({
        runId: "run-1",
        messageId: "msg-1",
        role: "assistant",
      });
      expect(event).toBeDefined();
      expect(event!.type).toBe("message.started");
    });
  });

  describe("messageCompleted", () => {
    it("returns undefined when messageId is missing", () => {
      expect(
        RunEventFacts.messageCompleted({ runId: "run-1" })
      ).toBeUndefined();
    });

    it("builds event when messageId is provided", () => {
      const event = RunEventFacts.messageCompleted({
        runId: "run-1",
        messageId: "msg-1",
      });
      expect(event).toBeDefined();
      expect(event!.type).toBe("message.completed");
    });
  });

  describe("toolStarted", () => {
    it("returns undefined when toolCallId is missing", () => {
      expect(RunEventFacts.toolStarted({ runId: "run-1" })).toBeUndefined();
    });

    it("builds event when toolCallId is provided", () => {
      const event = RunEventFacts.toolStarted({
        runId: "run-1",
        toolCallId: "tc-1",
        toolName: "bash",
      });
      expect(event).toBeDefined();
      expect(event!.type).toBe("tool.started");
      expect(event!.summary).toBe("bash");
    });
  });

  describe("toolCompleted", () => {
    it("returns undefined when toolCallId is missing", () => {
      expect(RunEventFacts.toolCompleted({ runId: "run-1" })).toBeUndefined();
    });

    it("builds event when toolCallId is provided", () => {
      const event = RunEventFacts.toolCompleted({
        runId: "run-1",
        toolCallId: "tc-1",
        contentPreview: "output",
      });
      expect(event).toBeDefined();
      expect(event!.type).toBe("tool.completed");
    });
  });

  describe("toolFailed", () => {
    it("returns undefined when toolCallId is missing", () => {
      expect(RunEventFacts.toolFailed({ runId: "run-1" })).toBeUndefined();
    });

    it("builds event with error summary", () => {
      const event = RunEventFacts.toolFailed({
        runId: "run-1",
        toolCallId: "tc-1",
        error: "denied",
      });
      expect(event).toBeDefined();
      expect(event!.type).toBe("tool.failed");
      expect(event!.summary).toBe("denied");
    });

    it("falls back to contentPreview for summary", () => {
      const event = RunEventFacts.toolFailed({
        runId: "run-1",
        toolCallId: "tc-1",
        contentPreview: "partial output",
      });
      expect(event!.summary).toBe("partial output");
    });
  });

  describe("systemIssue", () => {
    it("builds a system.issue event", () => {
      const event = RunEventFacts.systemIssue({
        runId: "run-1",
        code: "WORKER_CRASH",
        message: "Worker crashed",
        severity: "error",
      });
      expect(event.type).toBe("system.issue");
      expect(event.origin).toBe("platform");
      expect(event.data).toMatchObject({
        code: "WORKER_CRASH",
        message: "Worker crashed",
        severity: "error",
      });
    });

    it("uses custom origin", () => {
      const event = RunEventFacts.systemIssue({
        runId: "run-1",
        code: "TIMEOUT",
        origin: "worker",
      });
      expect(event.origin).toBe("worker");
    });
  });
});
