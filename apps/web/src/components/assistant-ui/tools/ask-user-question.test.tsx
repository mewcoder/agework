import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import {
  AskUserQuestionUI,
  PERMISSION_ALLOW_LABEL,
  PERMISSION_DENY_LABEL,
  PERMISSION_ALWAYS_ALLOW_LABEL,
  type AskUserQuestionItem,
  type AskUserQuestionInput,
} from "./ask-user-question";

// ── mocks ────────────────────────────────────────────────────────────────────

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

// ── fixtures ─────────────────────────────────────────────────────────────────

const permissionQuestion: AskUserQuestionItem = {
  question: "允许 Claude 使用 Read？",
  header: "权限请求",
  options: [
    {
      label: PERMISSION_ALLOW_LABEL,
      description: "~/todo-app/package.json\n原因：Path is outside allowed working directories",
    },
    { label: PERMISSION_DENY_LABEL, description: "拒绝本次工具调用。" },
  ],
};

const normalQuestion: AskUserQuestionItem = {
  question: "使用哪种方案？",
  header: "方案选择",
  options: [
    { label: "方案 A", description: "简单直接" },
    { label: "方案 B", description: "更灵活但复杂" },
  ],
};

function makePart(
  input: AskUserQuestionInput,
  status: { type: string } = { type: "running" },
  toolName: string = "AskUserQuestion",
) {
  return {
    toolCallId: `tc-${Math.random().toString(36).slice(2)}`,
    toolName,
    argsText: JSON.stringify(input),
    status: status as never,
  };
}

function makePermissionPart(
  input: AskUserQuestionInput,
  status: { type: string } = { type: "running" },
) {
  return makePart(input, status, "AskUserPermission");
}

// ── 渲染分流 ─────────────────────────────────────────────────────────────────
// 权限确认 vs 普通问答现在直接按 toolName 区分（AskUserPermission / AskUserQuestion），
// 不再靠 header/options 文案嗅探。

describe("AskUserQuestionUI 渲染分流", () => {
  it("toolName=AskUserPermission 渲染 Allow/Deny 按钮而非 RadioGroup", () => {
    render(<AskUserQuestionUI part={makePermissionPart({ questions: [permissionQuestion] })} />);

    expect(screen.getByRole("button", { name: /允许/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /拒绝/ })).toBeTruthy();
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.queryByText("其他")).toBeNull();
    expect(screen.queryByRole("button", { name: "确认" })).toBeNull();
  });

  it("toolName=AskUserQuestion 仍走 RadioGroup 路径", () => {
    render(<AskUserQuestionUI part={makePart({ questions: [normalQuestion] })} />);

    expect(screen.getAllByRole("radio").length).toBeGreaterThan(0);
    expect(screen.getByText("其他")).toBeTruthy();
    expect(screen.getByRole("button", { name: "确认" })).toBeTruthy();
  });

  it("权限请求显示原因描述", () => {
    render(<AskUserQuestionUI part={makePermissionPart({ questions: [permissionQuestion] })} />);

    expect(screen.getByText(/Path is outside allowed working directories/)).toBeTruthy();
  });
});

// ── 提交 ─────────────────────────────────────────────────────────────────────

describe("AskUserQuestionUI 权限提交", () => {
  it("点允许提交 answers[question]=允许", async () => {
    render(<AskUserQuestionUI part={makePermissionPart({ questions: [permissionQuestion] })} />);

    fireEvent.click(screen.getByRole("button", { name: /允许/ }));

    await waitFor(() => {
      expect(mockApiPost).toHaveBeenCalledWith(
        "/api/v1/conversations/agent/reply",
        {
          id: "conv-1",
          answers: { "允许 Claude 使用 Read？": PERMISSION_ALLOW_LABEL },
        }
      );
    });
  });

  it("点拒绝提交 answers[question]=拒绝", async () => {
    render(<AskUserQuestionUI part={makePermissionPart({ questions: [permissionQuestion] })} />);

    fireEvent.click(screen.getByRole("button", { name: /拒绝/ }));

    await waitFor(() => {
      expect(mockApiPost).toHaveBeenCalledWith(
        "/api/v1/conversations/agent/reply",
        {
          id: "conv-1",
          answers: { "允许 Claude 使用 Read？": PERMISSION_DENY_LABEL },
        }
      );
    });
  });

  it("提交后显示已选答案，按钮不再可点", async () => {
    render(<AskUserQuestionUI part={makePermissionPart({ questions: [permissionQuestion] })} />);

    fireEvent.click(screen.getByRole("button", { name: /允许/ }));

    await waitFor(() => {
      expect(mockApiPost).toHaveBeenCalled();
    });

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /允许/ })).toBeNull();
      expect(screen.queryByRole("button", { name: /拒绝/ })).toBeNull();
    });
  });
});

// ── 历史消息 fallback ────────────────────────────────────────────────────────

describe("AskUserQuestionUI 历史态 fallback", () => {
  it("权限审批历史态（非 running 无 answers）不消失，渲染折叠卡片", () => {
    // 后端权限审批的 argsText 只有 {questions} 没有 answers
    render(
      <AskUserQuestionUI
        part={makePermissionPart({ questions: [permissionQuestion] }, { type: "complete" })}
      />,
    );

    // 不应该 return null——至少要有 ToolFallback 的 trigger（工具名 AskUserPermission）
    expect(screen.getByText("AskUserPermission")).toBeTruthy();
    // 不应该有 Allow/Deny 按钮（非交互态）
    expect(screen.queryByRole("button", { name: /允许/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /拒绝/ })).toBeNull();
  });

  it("普通问答历史态（非 running 无 answers）不消失，渲染折叠卡片", () => {
    render(
      <AskUserQuestionUI
        part={makePart({ questions: [normalQuestion] }, { type: "complete" })}
      />,
    );

    expect(screen.getByText("AskUserQuestion")).toBeTruthy();
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.queryByRole("button", { name: "确认" })).toBeNull();
  });
});

describe("AskUserQuestionUI 始终允许按钮", () => {
  it("options 含'始终允许'时渲染三个按钮", () => {
    const input: AskUserQuestionInput = {
      questions: [
        {
          question: "允许 Claude 使用 Write？",
          header: "权限请求",
          options: [
            { label: PERMISSION_ALWAYS_ALLOW_LABEL, description: "本次及后续同类工具调用均自动放行。" },
            { label: PERMISSION_ALLOW_LABEL, description: "允许本次工具调用继续执行。" },
            { label: PERMISSION_DENY_LABEL, description: "拒绝本次工具调用。" },
          ],
        },
      ],
    };
    render(<AskUserQuestionUI part={makePermissionPart(input)} />);

    expect(screen.getByRole("button", { name: /始终允许/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^允许$/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /拒绝/ })).toBeTruthy();
  });

  it("options 不含'始终允许'时仍只渲染允许/拒绝两个按钮", () => {
    const input: AskUserQuestionInput = {
      questions: [
        {
          question: "允许 Claude 使用 Write？",
          header: "权限请求",
          options: [
            { label: PERMISSION_ALLOW_LABEL, description: "允许本次工具调用继续执行。" },
            { label: PERMISSION_DENY_LABEL, description: "拒绝本次工具调用。" },
          ],
        },
      ],
    };
    render(<AskUserQuestionUI part={makePermissionPart(input)} />);

    expect(screen.queryByRole("button", { name: /始终允许/ })).toBeNull();
    expect(screen.getByRole("button", { name: /允许/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /拒绝/ })).toBeTruthy();
  });

  it("点'始终允许'提交 answers[question]=始终允许", async () => {
    const input: AskUserQuestionInput = {
      questions: [
        {
          question: "允许 Claude 使用 Write？",
          header: "权限请求",
          options: [
            { label: PERMISSION_ALWAYS_ALLOW_LABEL, description: "本次及后续同类工具调用均自动放行。" },
            { label: PERMISSION_ALLOW_LABEL, description: "允许本次工具调用继续执行。" },
            { label: PERMISSION_DENY_LABEL, description: "拒绝本次工具调用。" },
          ],
        },
      ],
    };
    render(<AskUserQuestionUI part={makePermissionPart(input)} />);

    fireEvent.click(screen.getByRole("button", { name: /始终允许/ }));

    await waitFor(() => {
      expect(mockApiPost).toHaveBeenCalledWith(
        "/api/v1/conversations/agent/reply",
        {
          id: "conv-1",
          answers: { "允许 Claude 使用 Write？": PERMISSION_ALWAYS_ALLOW_LABEL },
        }
      );
    });
  });
});
