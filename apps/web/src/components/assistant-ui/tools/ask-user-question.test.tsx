import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import {
  AcpPermissionUI,
  AskUserQuestionUI,
  PERMISSION_ALLOW_LABEL,
  PERMISSION_DENY_LABEL,
  PERMISSION_ALWAYS_ALLOW_LABEL,
  type AskUserQuestionItem,
  type AskUserQuestionInput,
} from "./ask-user-question";
import type { PendingQuestion } from "@/components/assistant-ui/thread-utils";

// ── mocks ────────────────────────────────────────────────────────────────────

const mockSubmitInterruptResponses = vi.fn();
const mockSelectedConversationId = vi.fn(() => "conv-1");
const mockToastError = vi.fn();

vi.mock("@/lib/runtime/interrupt-runtime-registry", () => ({
  // 提交只带 getPendingQuestion 给的 interruptId,不再扫 runtime 的 pending 列表。
  getInterruptRuntime: () => ({
    unstable_submitInterruptResponses: (...args: unknown[]) =>
      mockSubmitInterruptResponses(...args),
  }),
}));

vi.mock("sonner", () => ({
  toast: { error: (...args: unknown[]) => mockToastError(...args) },
}));

vi.mock("@/stores/selection-store", () => ({
  useSelectionStore: (selector: (s: { selectedConversationId: string }) => unknown) =>
    selector({ selectedConversationId: mockSelectedConversationId() }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mockSelectedConversationId.mockReturnValue("conv-1");
  mockSubmitInterruptResponses.mockResolvedValue(undefined);
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

/** 待答描述固定件:open = metadata interrupt 已到,可提交。 */
function openPending(part: ReturnType<typeof makePart>): PendingQuestion {
  return {
    phase: "open",
    part,
    interrupt: { id: "int-1", reason: "tool_call" },
  } as unknown as PendingQuestion;
}

/** streaming = 窗口期,interrupt id 未到,表单可填但不可提交。 */
function streamingPending(part: ReturnType<typeof makePart>): PendingQuestion {
  return { phase: "streaming", part } as unknown as PendingQuestion;
}

// ── 渲染分流 ─────────────────────────────────────────────────────────────────
// 权限确认 vs 普通问答现在直接按 toolName 区分（AskUserPermission / AskUserQuestion），
// 不再靠 header/options 文案嗅探。

describe("AskUserQuestionUI 渲染分流", () => {
  it("toolName=AskUserPermission 渲染 Allow/Deny 按钮而非 RadioGroup", () => {
    const part = makePermissionPart({ questions: [permissionQuestion] });
    render(<AskUserQuestionUI part={part} pending={openPending(part)} />);

    expect(screen.getByRole("button", { name: /允许/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /拒绝/ })).toBeTruthy();
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.queryByText("其他")).toBeNull();
    expect(screen.queryByRole("button", { name: "确认" })).toBeNull();
  });

  it("toolName=AskUserQuestion 仍走 RadioGroup 路径", () => {
    const part = makePart({ questions: [normalQuestion] });
    render(<AskUserQuestionUI part={part} pending={openPending(part)} />);

    expect(screen.getAllByRole("radio").length).toBeGreaterThan(0);
    expect(screen.getByText("其他")).toBeTruthy();
    expect(screen.getByRole("button", { name: "确认" })).toBeTruthy();
  });

  it("权限请求显示原因描述", () => {
    const part = makePermissionPart({ questions: [permissionQuestion] });
    render(<AskUserQuestionUI part={part} pending={openPending(part)} />);

    expect(screen.getByText(/Path is outside allowed working directories/)).toBeTruthy();
  });

  it("ACP 权限请求使用固定标题并显示工具名", () => {
    const part = makePermissionPart({ questions: [permissionQuestion] });
    const pending = {
      ...openPending(part),
      acpPermission: true,
      interrupt: {
        id: "int-1",
        reason: "approval_required",
        message: "bash",
        metadata: {
          options: [
            { optionId: "once", name: "Allow once", kind: "allow_once" },
          ],
          toolCall: { title: "bash", rawInput: { command: "pwd" } },
        },
      },
    } as never;
    render(<AcpPermissionUI pending={pending} />);

    expect(screen.getByText("权限请求")).toBeTruthy();
    expect(screen.getByText("bash")).toBeTruthy();
  });
});

// ── 提交 ─────────────────────────────────────────────────────────────────────

describe("AskUserQuestionUI 权限提交", () => {
  it("点允许提交 answers[question]=允许", async () => {
    const part = makePermissionPart({ questions: [permissionQuestion] });
    render(<AskUserQuestionUI part={part} pending={openPending(part)} />);

    fireEvent.click(screen.getByRole("button", { name: /允许/ }));

    await waitFor(() => {
      expect(mockSubmitInterruptResponses).toHaveBeenCalledWith([
        {
          interruptId: "int-1",
          status: "resolved",
          payload: { answers: { "允许 Claude 使用 Read？": PERMISSION_ALLOW_LABEL } },
        },
      ]);
    });
  });

  it("点拒绝提交 answers[question]=拒绝", async () => {
    const part = makePermissionPart({ questions: [permissionQuestion] });
    render(<AskUserQuestionUI part={part} pending={openPending(part)} />);

    fireEvent.click(screen.getByRole("button", { name: /拒绝/ }));

    await waitFor(() => {
      expect(mockSubmitInterruptResponses).toHaveBeenCalledWith([
        {
          interruptId: "int-1",
          status: "resolved",
          payload: { answers: { "允许 Claude 使用 Read？": PERMISSION_DENY_LABEL } },
        },
      ]);
    });
  });

  it("提交后显示已选答案，按钮不再可点", async () => {
    const part = makePermissionPart({ questions: [permissionQuestion] });
    render(<AskUserQuestionUI part={part} pending={openPending(part)} />);

    fireEvent.click(screen.getByRole("button", { name: /允许/ }));

    await waitFor(() => {
      expect(mockSubmitInterruptResponses).toHaveBeenCalled();
    });

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /允许/ })).toBeNull();
      expect(screen.queryByRole("button", { name: /拒绝/ })).toBeNull();
    });
  });
});

// ── streaming 窗口期 ─────────────────────────────────────────────────────────
// TOOL_CALL_START/ARGS 已到、RUN_FINISHED{interrupt} 未到:interrupt id 还没
// 写进 metadata,物理上无法提交。表单可渲染,提交按钮必须禁用——
// 历史 bug:这个窗口期按钮可点,提交抛 "no pending interrupts" 被 console 吞。

describe("AskUserQuestionUI streaming 窗口期", () => {
  it("普通问答确认按钮禁用", () => {
    const part = makePart({ questions: [normalQuestion] });
    render(<AskUserQuestionUI part={part} pending={streamingPending(part)} />);

    const button = screen.getByRole("button", { name: "确认" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("权限按钮禁用,提交不发生", () => {
    const part = makePermissionPart({ questions: [permissionQuestion] });
    render(<AskUserQuestionUI part={part} pending={streamingPending(part)} />);

    const allow = screen.getByRole("button", { name: /允许/ }) as HTMLButtonElement;
    expect(allow.disabled).toBe(true);
    fireEvent.click(allow);
    expect(mockSubmitInterruptResponses).not.toHaveBeenCalled();
  });
});

// ── 提交失败反馈 ─────────────────────────────────────────────────────────────

describe("AskUserQuestionUI 提交失败", () => {
  it("失败经 toast.error 反馈,表单保持可交互(不静默吞错)", async () => {
    mockSubmitInterruptResponses.mockRejectedValueOnce(new Error("boom"));
    const part = makePermissionPart({ questions: [permissionQuestion] });
    render(<AskUserQuestionUI part={part} pending={openPending(part)} />);

    fireEvent.click(screen.getByRole("button", { name: /允许/ }));

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalled();
    });
    expect(screen.getByRole("button", { name: /允许/ })).toBeTruthy();
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
    const part = makePermissionPart(input);
    render(<AskUserQuestionUI part={part} pending={openPending(part)} />);

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
    const part = makePermissionPart(input);
    render(<AskUserQuestionUI part={part} pending={openPending(part)} />);

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
    const part = makePermissionPart(input);
    render(<AskUserQuestionUI part={part} pending={openPending(part)} />);

    fireEvent.click(screen.getByRole("button", { name: /始终允许/ }));

    await waitFor(() => {
      expect(mockSubmitInterruptResponses).toHaveBeenCalledWith([
        {
          interruptId: "int-1",
          status: "resolved",
          payload: { answers: { "允许 Claude 使用 Write？": PERMISSION_ALWAYS_ALLOW_LABEL } },
        },
      ]);
    });
  });
});

// ── ACP 权限卡片 ─────────────────────────────────────────────────────────────
// session/request_permission 的中断:无 tool part,选项全在 interrupt.metadata,
// 按 Agent 给的原始 options 渲染,提交 { decision: optionId }（不是 answers）。

type AcpPending = Extract<PendingQuestion, { acpPermission: true }>;

function acpPending(
  metadata: Record<string, unknown>,
  interrupt: Record<string, unknown> = { message: "Run a command" },
): AcpPending {
  return {
    phase: "open",
    part: null,
    acpPermission: true,
    interrupt: {
      id: "int-acp",
      reason: "approval_required",
      ...interrupt,
      metadata: { protocol: "acp", sessionId: "s-1", ...metadata },
    },
  } as unknown as AcpPending;
}

const acpOptions = [
  { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
  { optionId: "reject-once", name: "Reject", kind: "reject_once" },
];

describe("AcpPermissionUI 渲染", () => {
  it("按 ACP kind 本地化按钮文案", () => {
    render(<AcpPermissionUI pending={acpPending({ options: acpOptions })} />);

    expect(screen.getByRole("button", { name: "允许一次" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "拒绝" })).toBeTruthy();
  });

  it("kind 未知时回落到 agent 给的 name(不臆造选项)", () => {
    render(
      <AcpPermissionUI
        pending={acpPending({
          options: [{ optionId: "weird", name: "Do the thing", kind: "custom_kind" }],
        })}
      />,
    );

    expect(screen.getByRole("button", { name: "Do the thing" })).toBeTruthy();
  });

  it("展示 rawInput 里的操作对象,而不只是工具名", () => {
    render(
      <AcpPermissionUI
        pending={acpPending({
          options: acpOptions,
          toolCall: { title: "glob", kind: "search", rawInput: { pattern: ".agework/.env*" } },
        })}
      />,
    );

    expect(screen.getByText(".agework/.env*")).toBeTruthy();
  });

  it("rawInput 无已知字段时回落紧凑 JSON,全空则不显示", () => {
    const { unmount } = render(
      <AcpPermissionUI
        pending={acpPending({
          options: acpOptions,
          toolCall: { rawInput: { weird: "value" } },
        })}
      />,
    );
    expect(screen.getByText(/"weird":"value"/)).toBeTruthy();
    unmount();

    render(
      <AcpPermissionUI
        pending={acpPending({ options: acpOptions, toolCall: { rawInput: {} } })}
      />,
    );
    expect(screen.queryByText(/\{/)).toBeNull();
  });

  it("使用固定权限标题,工具名作为次级信息显示", () => {
    const { unmount } = render(
      <AcpPermissionUI
        pending={acpPending({
          options: acpOptions,
          toolCall: { title: "bash" },
        })}
      />,
    );
    expect(screen.getByText("权限请求")).toBeTruthy();
    expect(screen.getByText("bash")).toBeTruthy();
    unmount();

    // interrupt 完全不带 message 字段时仍保持固定标题。
    render(<AcpPermissionUI pending={acpPending({ options: acpOptions }, {})} />);
    expect(screen.getByText("权限请求")).toBeTruthy();
  });

  it("kind 以 reject 开头的选项用 outline 样式区分", () => {
    render(<AcpPermissionUI pending={acpPending({ options: acpOptions })} />);

    const allow = screen.getByRole("button", { name: "允许一次" });
    const reject = screen.getByRole("button", { name: "拒绝" });
    expect(reject.className).not.toBe(allow.className);
    expect(reject.className).toContain("border");
  });
});

// options 是 Agent 隔着 ACP 传来的原始数据,前端只做结构过滤,畸形不能炸组件。
describe("AcpPermissionUI options 容错", () => {
  it("丢弃缺 optionId / name 或非对象的条目", () => {
    render(
      <AcpPermissionUI
        pending={acpPending({
          options: [
            { optionId: "ok", name: "Keep me" },
            { optionId: "no-name" },
            { name: "no-id" },
            "not-an-object",
            null,
            { optionId: 42, name: 7 },
          ],
        })}
      />,
    );

    expect(screen.getByRole("button", { name: "Keep me" })).toBeTruthy();
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });

  it("options 缺失或不是数组时渲染标题但无按钮", () => {
    const { unmount } = render(<AcpPermissionUI pending={acpPending({})} />);
    expect(screen.getByText("权限请求")).toBeTruthy();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    unmount();

    render(<AcpPermissionUI pending={acpPending({ options: "nope" })} />);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });
});

describe("AcpPermissionUI 提交", () => {
  it("提交 { decision: optionId } 而非 answers", async () => {
    render(<AcpPermissionUI pending={acpPending({ options: acpOptions })} />);

    fireEvent.click(screen.getByRole("button", { name: "允许一次" }));

    await waitFor(() => {
      expect(mockSubmitInterruptResponses).toHaveBeenCalledWith([
        {
          interruptId: "int-acp",
          status: "resolved",
          payload: { decision: "allow-once" },
        },
      ]);
    });
  });

  it("拒绝分支同样提交自己的 optionId", async () => {
    render(<AcpPermissionUI pending={acpPending({ options: acpOptions })} />);

    fireEvent.click(screen.getByRole("button", { name: "拒绝" }));

    await waitFor(() => {
      expect(mockSubmitInterruptResponses).toHaveBeenCalledWith([
        {
          interruptId: "int-acp",
          status: "resolved",
          payload: { decision: "reject-once" },
        },
      ]);
    });
  });

  it("提交后按钮消失,显示已选项", async () => {
    render(<AcpPermissionUI pending={acpPending({ options: acpOptions })} />);

    fireEvent.click(screen.getByRole("button", { name: "允许一次" }));

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "拒绝" })).toBeNull();
    });
    // 回显的是按钮上那个本地化文案，不是协议里的英文 name
    expect(screen.getByText(/允许一次/)).toBeTruthy();
  });

  it("提交失败经 toast 反馈,按钮保持可点以便重试", async () => {
    mockSubmitInterruptResponses.mockRejectedValueOnce(new Error("boom"));
    render(<AcpPermissionUI pending={acpPending({ options: acpOptions })} />);

    fireEvent.click(screen.getByRole("button", { name: "允许一次" }));

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalled();
    });
    expect(screen.getByRole("button", { name: "允许一次" })).toBeTruthy();
  });

  it("没有选中会话时不提交", () => {
    mockSelectedConversationId.mockReturnValue("");
    render(<AcpPermissionUI pending={acpPending({ options: acpOptions })} />);

    fireEvent.click(screen.getByRole("button", { name: "允许一次" }));

    expect(mockSubmitInterruptResponses).not.toHaveBeenCalled();
  });
});
