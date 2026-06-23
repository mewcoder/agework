import { describe, expect, it } from "vitest";
import {
  aguiEventFacts,
  controlTraceFact,
  runStatusFact,
  sdkRawErrorFact,
  shouldLogAgUiEvent,
  workerSeqGapFact,
} from "./run-event-normalizer";

describe("run event normalizer", () => {
  it("normalizes run status payloads", () => {
    expect(
      runStatusFact("run-1", {
        status: "requires_action",
        pendingAction: "question",
      })
    ).toMatchObject({
      runId: "run-1",
      type: "run.status_changed",
      origin: "worker",
      targetType: "run",
      targetId: "run-1",
      data: {
        status: "requires_action",
        pendingAction: "question",
        reason: "question",
      },
    });
  });

  it("normalizes AG-UI tool failures into tool.failed facts", () => {
    const facts = aguiEventFacts("run-1", "TOOL_CALL_RESULT", {
      type: "TOOL_CALL_RESULT",
      toolCallId: "tool-1",
      messageId: "msg-1",
      content: JSON.stringify({ error: "permission denied" }),
    });

    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      type: "tool.failed",
      origin: "worker",
      targetType: "tool_call",
      targetId: "tool-1",
      chainId: "tool-1",
      refs: {
        toolCallId: "tool-1",
        messageId: "msg-1",
      },
      data: {
        error: "permission denied",
      },
    });
  });

  it("only emits SDK raw facts for error-like provider events", () => {
    expect(
      sdkRawErrorFact("run-1", {
        name: "sdk.claude.output",
        threadId: "thread-1",
      })
    ).toBeUndefined();

    expect(
      sdkRawErrorFact("run-1", {
        name: "sdk.claude.error",
        threadId: "thread-1",
      })
    ).toMatchObject({
      type: "system.issue",
      origin: "agent",
      data: {
        code: "sdk_error",
        providerEventName: "sdk.claude.error",
        threadId: "thread-1",
      },
    });
  });

  it("normalizes control trace events by phase", () => {
    expect(
      controlTraceFact("run-1", {
        commandId: "cmd-1",
        controlType: "cancel",
        phase: "handled",
      })
    ).toMatchObject({
      type: "control.handled",
      targetType: "command",
      targetId: "cmd-1",
      chainId: "cmd-1",
      data: { commandType: "cancel", phase: "handled" },
    });

    expect(
      controlTraceFact("run-1", {
        commandId: "cmd-1",
        controlType: "cancel",
        phase: "failed",
        error: "not active",
      })
    ).toMatchObject({
      type: "control.failed",
      summary: "not active",
      data: { commandType: "cancel", phase: "failed", error: "not active" },
    });
  });

  it("normalizes worker sequence gaps as system issues", () => {
    expect(
      workerSeqGapFact({
        runId: "run-1",
        expected: 2,
        got: 4,
        envelopeType: "agui.event",
      })
    ).toMatchObject({
      type: "system.issue",
      origin: "worker",
      summary: "expected seq 2, got 4",
      data: {
        code: "worker_seq_gap",
        severity: "warn",
        expected: 2,
        got: 4,
        envelopeType: "agui.event",
      },
    });
  });

  it("keeps AG-UI debug logging scoped to lifecycle boundaries", () => {
    expect(shouldLogAgUiEvent("TEXT_MESSAGE_START")).toBe(true);
    expect(shouldLogAgUiEvent("TEXT_MESSAGE_CONTENT")).toBe(false);
    expect(shouldLogAgUiEvent("RUN_ERROR")).toBe(true);
  });
});
