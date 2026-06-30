import { describe, it, expect, vi } from "vitest";
import { createThreadListAdapter } from "./thread-list-adapter";

vi.mock("@/api/conversations", () => ({
  conversationsApi: {
    list: vi.fn().mockResolvedValue({ conversations: [] }),
    create: vi.fn().mockResolvedValue({
      conversationId: "t1", workspaceId: "p1", status: "regular",
      runStatus: "idle", pendingUserAction: null, createdAt: "", updatedAt: "",
    }),
    archive: vi.fn().mockResolvedValue(undefined),
    unarchive: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/stores/selection-store", () => ({
  useSelectionStore: {
    getState: vi.fn().mockReturnValue({
      selectedWorkspaceId: "p1", selectedAgentType: "claude",
    }),
  },
}));

vi.mock("assistant-stream", () => ({
  createAssistantStream: vi.fn().mockReturnValue({}),
}));

vi.mock("@/lib/runtime/thread-history-provider", () => ({
  ThreadHistoryProvider: () => null,
}));

describe("createThreadListAdapter — 归档回调", () => {
  it("archive 调用后端 API 后触发 onThreadArchived 回调", async () => {
    const onThreadArchived = vi.fn();
    const adapter = createThreadListAdapter(onThreadArchived);

    await adapter.archive("thread-123");

    expect(onThreadArchived).toHaveBeenCalledWith("thread-123");
  });

  it("不传回调时 archive 不报错（回调为可选参数）", async () => {
    const adapter = createThreadListAdapter();

    await expect(adapter.archive("thread-456")).resolves.toBeUndefined();
  });

  it("onThreadArchived 回调只调用一次", async () => {
    const onThreadArchived = vi.fn();
    const adapter = createThreadListAdapter(onThreadArchived);

    await adapter.archive("thread-789");

    expect(onThreadArchived).toHaveBeenCalledTimes(1);
  });

  it("归档不同的 conversationId 回调参数不同", async () => {
    const onThreadArchived = vi.fn();
    const adapter = createThreadListAdapter(onThreadArchived);

    await adapter.archive("thread-a");
    await adapter.archive("thread-b");

    expect(onThreadArchived).toHaveBeenCalledTimes(2);
    expect(onThreadArchived).toHaveBeenCalledWith("thread-a");
    expect(onThreadArchived).toHaveBeenCalledWith("thread-b");
  });

  it("不再使用 CustomEvent — window 上无 agework:thread-archived 事件", async () => {
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");
    const adapter = createThreadListAdapter(() => {});

    await adapter.archive("thread-x");

    // 确认没有 dispatch CustomEvent
    expect(dispatchSpy).not.toHaveBeenCalled();
  });
});
