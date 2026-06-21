import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { AskUserQuestionCompact } from "./pending-question-panel";
import { PERMISSION_ALLOW_LABEL, PERMISSION_DENY_LABEL } from "./tools/ask-user-question";
import { findPendingQuestionPart } from "./thread-utils";

const mockApiPost = vi.fn();
const mockSelectedConversationId = vi.fn(() => "conv-1");

vi.mock("@/lib/http", () => ({
  apiGet: vi.fn(),
  apiPost: (...args: unknown[]) => mockApiPost(...args),
}));

vi.mock("@/stores/selection-store", () => ({
  useSelectionStore: (selector: (s: { selectedConversationId: string }) => unknown) =>
    selector({ selectedConversationId: mockSelectedConversationId() }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mockSelectedConversationId.mockReturnValue("conv-1");
  mockApiPost.mockResolvedValue({});
});

const permissionInput = {
  questions: [
    {
      question: "允许 Claude 使用 Read？",
      header: "权限请求",
      options: [
        { label: PERMISSION_ALLOW_LABEL, description: "允许本次工具调用继续执行。" },
        { label: PERMISSION_DENY_LABEL, description: "拒绝本次工具调用。" },
      ],
    },
  ],
};

function makePart(toolCallId: string, status: { type: string } = { type: "running" }) {
  return {
    type: "tool-call",
    toolCallId,
    toolName: "AskUserPermission",
    args: {},
    argsText: JSON.stringify(permissionInput),
    status,
  } as never;
}

describe("AskUserQuestionCompact", () => {
  it("running 的权限请求显示等待权限确认", () => {
    render(<AskUserQuestionCompact part={makePart("tc-pending")} />);
    expect(screen.getByText("等待权限确认")).toBeTruthy();
  });
});

describe("findPendingQuestionPart", () => {
  function assistantMessage(parts: unknown[]) {
    return { role: "assistant", parts };
  }

  function makeAnsweredPart(toolCallId: string) {
    // 已回答的权限请求：后端补发了 TOOL_CALL_RESULT，result 被设置后
    // status 不再是 running（见 ask-user-question.tsx 的 TOOL_CALL_RESULT
    // 修复），这里用 complete 模拟回答后的真实状态。
    return makePart(toolCallId, { type: "complete" });
  }

  it("跳过已回答（status 不是 running）的 part", () => {
    const messages = [assistantMessage([makeAnsweredPart("tc-already-answered")])];

    const pending = findPendingQuestionPart(messages);

    expect(pending).toBeNull();
  });

  it("找到真正待回答的 running part", () => {
    const messages = [assistantMessage([makePart("tc-real-pending")])];

    const pending = findPendingQuestionPart(messages);

    expect(pending?.toolCallId).toBe("tc-real-pending");
  });

  it("一条消息里第一个已回答、第二个未回答时，找到第二个", () => {
    const messages = [
      assistantMessage([
        makeAnsweredPart("tc-already-answered"),
        makePart("tc-real-pending"),
      ]),
    ];

    const pending = findPendingQuestionPart(messages);

    expect(pending?.toolCallId).toBe("tc-real-pending");
  });
});
