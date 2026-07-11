import { describe, it, expect, vi, afterEach } from "vitest";
import { createThreadHistoryAdapter } from "./thread-history-adapter";
import { conversationsApi } from "@/api/conversations";

// resume 数据流(SSE 解析、快照归一化、runStatus 回填、409 重试)的测试
// 在 @/stores/run-session-resume.test.ts,这里只测 load() 的接线行为。

// ── load() requires_action（pendingUserAction=question）场景 ─────────────────

describe("load() requires_action 场景", () => {
  function makeLoadAdapter(opts: {
    remoteId: string;
    runStatus: string;
    pendingUserAction?: string | null;
    messages: unknown[];
  }) {
    const { remoteId, runStatus, pendingUserAction, messages } = opts;
    const aui = {
      threadListItem: () => ({
        getState: () => ({
          remoteId,
          custom: { runStatus, pendingUserAction: pendingUserAction ?? null },
        }),
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    // mock conversationsApi.listMessages
    const listMessagesSpy = vi
      .spyOn(conversationsApi, "listMessages")
      .mockResolvedValue(messages as never);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const qc = {} as any;
    const adapter = createThreadHistoryAdapter(aui, qc);
    return { adapter, listMessagesSpy };
  }

  function assistantMsg(id: string, statusType: string) {
    return {
      id,
      parent_id: null,
      content: {
        id,
        role: "assistant",
        content: [{ type: "text", text: "thinking..." }],
        status: { type: statusType },
      },
    };
  }

  function userMsg(id: string) {
    return {
      id,
      parent_id: null,
      content: { id, role: "user", content: "hello" },
    };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("pendingUserAction=question 时不触发 resume，不过滤消息，requires-action 状态原样保留", async () => {
    const { adapter } = makeLoadAdapter({
      remoteId: "c1",
      runStatus: "running",
      pendingUserAction: "question",
      messages: [
        userMsg("u1"),
        // 待答消息以 requires-action/interrupt 持久化,原样加载供
        // PendingQuestionPanel 判定与 interrupt resume 使用
        assistantMsg("a1", "requires-action"),
      ],
    });

    const result = await adapter.load!();

    // 不触发 resume
    expect(result.unstable_resume).toBeUndefined();
    // 消息未被过滤
    expect(result.messages).toHaveLength(2);
    // requires-action 状态原样保留(不再归一化成 running)
    const assistantMsgResult = result.messages[1] as unknown as {
      message: { status: { type: string } };
    };
    expect(assistantMsgResult.message.status.type).toBe("requires-action");
  });

  it("正常 running（无 pendingUserAction）时触发 resume，过滤进行中消息", async () => {
    const { adapter } = makeLoadAdapter({
      remoteId: "c1",
      runStatus: "running",
      pendingUserAction: null,
      messages: [
        userMsg("u1"),
        assistantMsg("a1", "running"), // 进行中的，应被过滤
      ],
    });

    const result = await adapter.load!();

    // 触发 resume
    expect(result.unstable_resume).toBe(true);
    // 进行中消息被过滤
    expect(result.messages).toHaveLength(1);
    expect(
      (result.messages[0] as unknown as { message: { role: string } }).message
        .role,
    ).toBe("user");
  });

  it("idle 时不过滤、不 resume", async () => {
    const { adapter } = makeLoadAdapter({
      remoteId: "c1",
      runStatus: "idle",
      pendingUserAction: null,
      messages: [
        userMsg("u1"),
        assistantMsg("a1", "complete"), // 已完成，保留
      ],
    });

    const result = await adapter.load!();

    expect(result.unstable_resume).toBeUndefined();
    expect(result.messages).toHaveLength(2);
  });
});
