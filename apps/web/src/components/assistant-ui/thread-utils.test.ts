import { describe, it, expect } from "vitest";
import { withAgUiCustomMetadata } from "@assistant-ui/react-ag-ui";
import { getPendingQuestion } from "./thread-utils";

/**
 * 待答描述的唯一 selector:metadata(权威)→ open,流式窗口期(part 已在、
 * RUN_FINISHED{interrupt} 未到)→ streaming,其余 → null。
 */

function questionPart(overrides: Record<string, unknown> = {}) {
  return {
    type: "tool-call",
    toolCallId: "tc-1",
    toolName: "AskUserQuestion",
    argsText: "{}",
    status: { type: "running" },
    ...overrides,
  };
}

function assistantMessage(overrides: Record<string, unknown> = {}) {
  return {
    role: "assistant",
    parts: [questionPart()],
    status: { type: "running" },
    metadata: {},
    ...overrides,
  };
}

const INTERRUPT = { id: "int-1", reason: "input_required", toolCallId: "tc-1" };

function interruptedMessage(parts: unknown[] = [questionPart({ status: { type: "requires-action" } })]) {
  return assistantMessage({
    parts,
    status: { type: "requires-action", reason: "interrupt" },
    metadata: withAgUiCustomMetadata({}, { interrupts: [INTERRUPT] }),
  });
}

describe("getPendingQuestion", () => {
  it("metadata interrupts + 匹配 part → open,带 interrupt id", () => {
    const pending = getPendingQuestion([interruptedMessage()]);
    expect(pending?.phase).toBe("open");
    if (
      pending?.phase === "open" &&
      !("confirmation" in pending) &&
      !("acpPermission" in pending) &&
      pending.part
    ) {
      expect(pending.interrupt.id).toBe("int-1");
      expect(pending.part.toolCallId).toBe("tc-1");
    }
  });

  it("interrupt.toolCallId 缺失时按问答 part 扫描仍能 join 到 open", () => {
    const msg = assistantMessage({
      parts: [questionPart({ status: { type: "requires-action" } })],
      status: { type: "requires-action", reason: "interrupt" },
      metadata: withAgUiCustomMetadata({}, {
        interrupts: [{ id: "int-2", reason: "tool_call" }],
      }),
    });
    const pending = getPendingQuestion([msg]);
    expect(pending?.phase).toBe("open");
  });

  it("窗口期(running part、metadata 无 interrupts)→ streaming", () => {
    const pending = getPendingQuestion([assistantMessage()]);
    expect(pending?.phase).toBe("streaming");
  });

  it("part.result 已回填 → null(已答,不再待答)", () => {
    const answered = interruptedMessage([
      questionPart({ status: { type: "requires-action" }, result: { answers: {} } }),
    ]);
    expect(getPendingQuestion([answered])).toBeNull();
  });

  it("终态 complete 消息 → null", () => {
    const done = assistantMessage({
      parts: [questionPart({ status: { type: "complete" } })],
      status: { type: "complete" },
    });
    expect(getPendingQuestion([done])).toBeNull();
  });

  it("非问答 tool part → null", () => {
    const other = assistantMessage({
      parts: [questionPart({ toolName: "Read" })],
    });
    expect(getPendingQuestion([other])).toBeNull();
  });

  it("空列表 → null", () => {
    expect(getPendingQuestion([])).toBeNull();
  });
});
