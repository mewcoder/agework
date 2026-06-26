import { describe, expect, it } from "vitest";
import { RunMessageAggregator } from "./run-message.aggregator";

describe("RunMessageAggregator", () => {
  it("uses streaming for incomplete snapshots by default", () => {
    const aggregator = new RunMessageAggregator();
    aggregator.handle({ type: "RUN_STARTED" });
    aggregator.handle({
      type: "TEXT_MESSAGE_START",
      messageId: "msg-1",
      role: "assistant",
    });
    aggregator.handle({
      type: "TEXT_MESSAGE_CONTENT",
      messageId: "msg-1",
      delta: "hello",
    });

    expect(aggregator.build(false).status).toEqual({
      type: "incomplete",
      reason: "streaming",
    });
  });

  it("preserves cancelled for explicit run cancellation", () => {
    const aggregator = new RunMessageAggregator();
    aggregator.handle({ type: "RUN_STARTED" });
    aggregator.handle({
      type: "TEXT_MESSAGE_START",
      messageId: "msg-1",
      role: "assistant",
    });
    aggregator.handle({
      type: "TEXT_MESSAGE_CONTENT",
      messageId: "msg-1",
      delta: "hello",
    });
    aggregator.handle({ type: "RUN_CANCELLED" });

    expect(aggregator.build(false).status).toEqual({
      type: "incomplete",
      reason: "cancelled",
    });
  });

  it("can mark a cancelled stream as user-steered", () => {
    const aggregator = new RunMessageAggregator();
    aggregator.handle({ type: "RUN_STARTED" });
    aggregator.handle({
      type: "TEXT_MESSAGE_START",
      messageId: "msg-1",
      role: "assistant",
    });
    aggregator.handle({
      type: "TEXT_MESSAGE_CONTENT",
      messageId: "msg-1",
      delta: "hello",
    });
    aggregator.handle({ type: "RUN_CANCELLED" });

    expect(aggregator.build(false, "user_steered").status).toEqual({
      type: "incomplete",
      reason: "user_steered",
    });
  });

  it("reports the server messageId from TEXT_MESSAGE_START", () => {
    const aggregator = new RunMessageAggregator();
    aggregator.handle({ type: "RUN_STARTED" });
    aggregator.handle({
      type: "TEXT_MESSAGE_START",
      messageId: "msg-1",
      role: "assistant",
    });
    aggregator.handle({
      type: "TEXT_MESSAGE_CONTENT",
      messageId: "msg-1",
      delta: "hello",
    });
    aggregator.handle({ type: "RUN_FINISHED" });

    expect(aggregator.build(true).messageId).toBe("msg-1");
  });

  it("reports complete/unknown for a normal RUN_FINISHED (shared with the frontend aggregator)", () => {
    const aggregator = new RunMessageAggregator();
    aggregator.handle({ type: "RUN_STARTED" });
    aggregator.handle({ type: "TEXT_MESSAGE_CONTENT", delta: "hello" });
    aggregator.handle({ type: "RUN_FINISHED" });

    expect(aggregator.build(true).status).toEqual({
      type: "complete",
      reason: "unknown",
    });
  });

  it("stamps mcp-apps activity snapshots onto resolved tool calls (newly shared with the frontend aggregator)", () => {
    const aggregator = new RunMessageAggregator();
    aggregator.handle({ type: "RUN_STARTED" });
    aggregator.handle({
      type: "TOOL_CALL_START",
      toolCallId: "tool1",
      toolCallName: "show_map",
    });
    aggregator.handle({
      type: "TOOL_CALL_RESULT",
      toolCallId: "tool1",
      content: '{"ok":true}',
      role: "tool",
    });
    aggregator.handle({
      type: "ACTIVITY_SNAPSHOT",
      activityType: "mcp-apps",
      content: { resourceUri: "ui://srv/mcp-app.html" },
    });

    const snap = aggregator.build(false);
    const toolPart = snap.content.find(
      (part: any) => part.type === "tool-call"
    ) as any;
    expect(toolPart.mcp).toEqual({
      app: { resourceUri: "ui://srv/mcp-app.html" },
    });
  });
});
