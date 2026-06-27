import { describe, expect, it } from "vitest";
import { toAgentRunInput } from "./agent-driver";

describe("toAgentRunInput", () => {
  it("keeps an existing AG-UI thread id", () => {
    const input = toAgentRunInput(
      { threadId: "thread-1", messages: [] },
      "conversation-1"
    );

    expect(input).toEqual({
      aguiThreadId: "thread-1",
      payload: {
        threadId: "thread-1",
        messages: [],
      },
    });
  });

  it("uses the fallback conversation id when thread id is missing", () => {
    const input = toAgentRunInput({ messages: [] }, "conversation-1");

    expect(input).toEqual({
      aguiThreadId: "conversation-1",
      payload: {
        threadId: "conversation-1",
        messages: [],
      },
    });
  });
});
