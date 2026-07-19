import { describe, expect, it } from "vitest";
import { MockAgentDriver } from "./mock-agent.driver";
import type { AgentRunInput } from "./index";

function makeInput(text: string): AgentRunInput {
  return {
    aguiThreadId: "conversation-1",
    payload: {
      threadId: "conversation-1",
      runId: "run-1",
      messages: [
        { id: "m0", role: "assistant", content: "earlier" },
        { id: "m1", role: "user", content: text },
      ],
    },
  };
}

function collect(driver: MockAgentDriver, input: AgentRunInput) {
  const events: Array<{ type: string; delta?: string }> = [];
  return new Promise<{
    events: Array<{ type: string; delta?: string }>;
    outcome: "complete" | "error";
  }>((resolve) => {
    driver.run(input).subscribe({
      next: (event) => events.push(event as { type: string }),
      complete: () => resolve({ events, outcome: "complete" }),
      error: () => resolve({ events, outcome: "error" }),
    });
  });
}

describe("MockAgentDriver", () => {
  it("streams a deterministic echo reply and finishes", async () => {
    const { events, outcome } = await collect(
      new MockAgentDriver(),
      makeInput("hello")
    );

    expect(outcome).toBe("complete");
    expect(events.map((e) => e.type)).toEqual([
      "RUN_STARTED",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "RUN_FINISHED",
    ]);
    const text = events
      .filter((e) => e.type === "TEXT_MESSAGE_CONTENT")
      .map((e) => e.delta)
      .join("");
    expect(text).toBe("mock reply: hello");
    expect(events[0]).toMatchObject({
      threadId: "conversation-1",
      runId: "run-1",
    });
  });

  it("reads text parts arrays and tolerates an empty prompt", async () => {
    const input = makeInput("");
    input.payload.messages = [
      {
        id: "m1",
        role: "user",
        content: [{ type: "text", text: "part-a " }, { type: "text", text: "part-b" }],
      },
    ];
    const { events } = await collect(new MockAgentDriver(), input);
    const text = events
      .filter((e) => e.type === "TEXT_MESSAGE_CONTENT")
      .map((e) => e.delta)
      .join("");
    expect(text).toBe("mock reply: part-a part-b");
  });

  it("aborts a [slow] stream on cancel without emitting RUN_FINISHED", async () => {
    const driver = new MockAgentDriver();
    const resultPromise = collect(driver, makeInput("please [slow] run"));

    // 等首个内容块出来再取消,保证取消发生在流中途
    await new Promise((resolve) => setTimeout(resolve, 400));
    await driver.cancel();

    const { events, outcome } = await resultPromise;
    expect(outcome).toBe("complete");
    const types = events.map((e) => e.type);
    expect(types).toContain("RUN_STARTED");
    expect(types).not.toContain("RUN_FINISHED");
    expect(types).not.toContain("TEXT_MESSAGE_END");
    // 30s 的完整流被截断:内容块远少于 120
    expect(
      types.filter((t) => t === "TEXT_MESSAGE_CONTENT").length
    ).toBeLessThan(10);
  });

  it("does not claim pending controls", () => {
    expect(new MockAgentDriver().resolveControl()).toBe(false);
  });
});
