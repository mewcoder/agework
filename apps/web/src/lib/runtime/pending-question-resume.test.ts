import { describe, it, expect } from "vitest";
import {
  dropStalePendingQuestionMessage,
  needsManualResumeReconnect,
  toExportedMessageRepository,
} from "./pending-question-resume";

type Msg = { id: string; role: string; status?: { type?: string } };

describe("dropStalePendingQuestionMessage", () => {
  it("去掉末尾 running 状态的 assistant 消息", () => {
    const messages: Msg[] = [
      { id: "u1", role: "user" },
      { id: "a1", role: "assistant", status: { type: "running" } },
    ];

    const result = dropStalePendingQuestionMessage(messages);

    expect(result.removed).toBe(true);
    expect(result.messages).toEqual([{ id: "u1", role: "user" }]);
  });

  it("末尾 assistant 消息已 complete 时不去掉", () => {
    const messages: Msg[] = [
      { id: "u1", role: "user" },
      { id: "a1", role: "assistant", status: { type: "complete" } },
    ];

    const result = dropStalePendingQuestionMessage(messages);

    expect(result.removed).toBe(false);
    expect(result.messages).toBe(messages);
  });

  it("末尾消息是 user 时不去掉", () => {
    const messages: Msg[] = [{ id: "u1", role: "user" }];

    const result = dropStalePendingQuestionMessage(messages);

    expect(result.removed).toBe(false);
    expect(result.messages).toBe(messages);
  });

  it("空数组不报错、不去掉", () => {
    const result = dropStalePendingQuestionMessage([]);

    expect(result.removed).toBe(false);
    expect(result.messages).toEqual([]);
  });
});

describe("needsManualResumeReconnect", () => {
  it("isRunning=false（刷新后丢失原始 SSE 连接）时需要手动 resume 重连", () => {
    expect(needsManualResumeReconnect(false)).toBe(true);
  });

  it("isRunning=true（原始 SSE 连接仍存活，未刷新页面）时不需要手动 resume", () => {
    expect(needsManualResumeReconnect(true)).toBe(false);
  });
});

describe("toExportedMessageRepository", () => {
  it("按顺序串联 parentId，并保留原始消息对象引用", () => {
    const messages = [{ id: "u1" }, { id: "a1" }, { id: "a2" }];

    const repo = toExportedMessageRepository(messages);

    expect(repo.headId).toBe("a2");
    expect(repo.messages).toEqual([
      { parentId: null, message: { id: "u1" } },
      { parentId: "u1", message: { id: "a1" } },
      { parentId: "a1", message: { id: "a2" } },
    ]);
    expect(repo.messages[1]!.message).toBe(messages[1]);
  });

  it("空数组返回 headId=null 且 messages=[]", () => {
    const repo = toExportedMessageRepository([]);

    expect(repo).toEqual({ headId: null, messages: [] });
  });
});
