import { describe, it, expect } from "vitest";
import type { ChatModelRunResult } from "@assistant-ui/react";
import {
  normalizeResumeSnapshot,
  runStatusFromSnapshot,
  conversationStateFromRunFinished,
  RUN_STARTED_CONVERSATION_STATE,
} from "./run-session-status-rules";

describe("normalizeResumeSnapshot", () => {
  it("把中间快照 incomplete/streaming 归一化成 running", () => {
    const result = normalizeResumeSnapshot({
      content: [{ type: "tool-call", toolCallId: "t1", toolName: "Read" }],
      status: { type: "incomplete", reason: "streaming" },
    } as unknown as ChatModelRunResult);
    expect(result.status).toEqual({ type: "running" });
    // content 等其它字段保留
    expect(result.content).toHaveLength(1);
  });

  it("终态快照 complete 保持原样", () => {
    const result = normalizeResumeSnapshot({
      content: [{ type: "text", text: "done" }],
      status: { type: "complete", reason: "stop" },
    });
    expect(result.status).toEqual({ type: "complete", reason: "stop" });
  });

  it("终态快照 cancelled 保持原样（reason 非 streaming）", () => {
    const result = normalizeResumeSnapshot({
      content: [],
      status: { type: "incomplete", reason: "cancelled" },
    });
    expect(result.status).toEqual({ type: "incomplete", reason: "cancelled" });
  });

  it("终态快照 error 保持原样", () => {
    const result = normalizeResumeSnapshot({
      content: [],
      status: { type: "incomplete", reason: "error", error: "boom" },
    });
    expect(result.status).toEqual({ type: "incomplete", reason: "error", error: "boom" });
  });

  it("已经是 running 的快照不变", () => {
    const result = normalizeResumeSnapshot({
      content: [],
      status: { type: "running" },
    });
    expect(result.status).toEqual({ type: "running" });
  });
});

describe("runStatusFromSnapshot", () => {
  it("complete → idle", () => {
    expect(runStatusFromSnapshot({ type: "complete" })).toBe("idle");
  });

  it("incomplete/error → error", () => {
    expect(runStatusFromSnapshot({ type: "incomplete", reason: "error" })).toBe("error");
  });

  it("incomplete/cancelled → idle", () => {
    expect(runStatusFromSnapshot({ type: "incomplete", reason: "cancelled" })).toBe("idle");
  });

  it("incomplete/user_steered → idle", () => {
    expect(runStatusFromSnapshot({ type: "incomplete", reason: "user_steered" })).toBe("idle");
  });

  it("incomplete/streaming（非终态）→ undefined，交给兜底", () => {
    expect(runStatusFromSnapshot({ type: "incomplete", reason: "streaming" })).toBeUndefined();
  });

  it("requires-action → undefined(挂起非终态:后端真相是 running+question,规则不重复写)", () => {
    expect(runStatusFromSnapshot({ type: "requires-action" })).toBeUndefined();
  });

  it("缺省 → undefined", () => {
    expect(runStatusFromSnapshot(undefined)).toBeUndefined();
  });
});

describe("conversationStateFromRunFinished", () => {
  it("interrupt outcome → 只写 pendingUserAction=question,不动 runStatus", () => {
    expect(conversationStateFromRunFinished({ type: "interrupt" })).toEqual({
      pendingUserAction: "question",
    });
  });

  it("success outcome → idle", () => {
    expect(conversationStateFromRunFinished({ type: "success" })).toEqual({
      runStatus: "idle",
    });
  });

  it("无 outcome → idle", () => {
    expect(conversationStateFromRunFinished(undefined)).toEqual({
      runStatus: "idle",
    });
  });
});

describe("RUN_STARTED_CONVERSATION_STATE", () => {
  it("run 启动(含答题 resume run)= running + 清掉待答标记", () => {
    expect(RUN_STARTED_CONVERSATION_STATE).toEqual({
      runStatus: "running",
      pendingUserAction: null,
    });
  });
});
