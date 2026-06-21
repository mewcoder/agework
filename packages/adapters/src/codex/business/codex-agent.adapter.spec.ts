import { CodexAgentAdapter } from "./codex-agent.adapter";
import { vi } from "vitest";

const completedAgentMessage = {
  type: "item.completed",
  item: {
    type: "agent_message",
    id: "item_0",
    text: "done",
  },
};

const completedTurn = {
  type: "turn.completed",
  usage: {
    input_tokens: 1,
    cached_input_tokens: 0,
    output_tokens: 1,
    reasoning_output_tokens: 0,
  },
};

describe("CodexAgentAdapter", () => {
  it("instantiates without options", () => {
    expect(() => new CodexAgentAdapter()).not.toThrow();
  });

  it("normalizes baseUrl by appending /v1", () => {
    const adapter = new CodexAgentAdapter({
      baseUrl: "https://api.example.com",
    });
    expect(adapter).toBeInstanceOf(CodexAgentAdapter);
  });

  it("accepts a trailing-slash baseUrl and strips it before appending /v1", () => {
    const adapter = new CodexAgentAdapter({
      baseUrl: "https://api.example.com/",
    });
    expect(adapter).toBeInstanceOf(CodexAgentAdapter);
  });

  it("passes through all config fields without throwing", () => {
    expect(
      () =>
        new CodexAgentAdapter({
          apiKey: "test-key",
          baseUrl: "https://api.example.com/v1",
          model: "o4-mini",
          cwd: "/tmp/project",
        })
    ).not.toThrow();
  });

  it("interrupt(threadId) only aborts that thread's controller", async () => {
    const adapter = new CodexAgentAdapter({});
    const abortA = vi.fn();
    const abortB = vi.fn();
    const internals = adapter as unknown as {
      activeRuns: Map<string, { abort: () => void }>;
    };
    internals.activeRuns.set("thread-a", { abort: abortA } as never);
    internals.activeRuns.set("thread-b", { abort: abortB } as never);

    await adapter.interrupt("thread-a");

    expect(abortA).toHaveBeenCalledTimes(1);
    expect(abortB).not.toHaveBeenCalled();
  });

  it("interrupt() with no arg aborts all controllers", async () => {
    const adapter = new CodexAgentAdapter({});
    const abortA = vi.fn();
    const abortB = vi.fn();
    const internals = adapter as unknown as {
      activeRuns: Map<string, { abort: () => void }>;
    };
    internals.activeRuns.set("thread-a", { abort: abortA } as never);
    internals.activeRuns.set("thread-b", { abort: abortB } as never);

    await adapter.interrupt();

    expect(abortA).toHaveBeenCalledTimes(1);
    expect(abortB).toHaveBeenCalledTimes(1);
  });

  it("waits for the Codex stream to drain after turn.completed before resolving", async () => {
    const adapter = new CodexAgentAdapter({});
    let releaseDrain: (() => void) | undefined;
    async function* events() {
      yield completedAgentMessage;
      yield completedTurn;
      await new Promise<void>((resolve) => {
        releaseDrain = resolve;
      });
    }
    const internals = adapter as unknown as {
      translateStream(
        events: AsyncGenerator<unknown>,
        threadId: string,
        runId: string,
        input: Record<string, unknown>,
        isNewThread: boolean,
        subscriber: { next: (event: unknown) => void },
        runCtx: { lastResultData: unknown }
      ): Promise<void>;
    };

    let settled = false;
    const done = internals
      .translateStream(
        events(),
        "thread-1",
        "run-1",
        { messages: [] },
        true,
        { next: vi.fn() },
        { lastResultData: undefined }
      )
      .then(() => {
        settled = true;
      });

    await Promise.resolve();
    await Promise.resolve();

    await vi.waitFor(() => {
      expect(releaseDrain).toBeTypeOf("function");
    });
    expect(settled).toBe(false);

    releaseDrain!();
    await done;

    expect(settled).toBe(true);
  });

  it("does not flip an already-successful turn into an error when draining observes a trailing error", async () => {
    const adapter = new CodexAgentAdapter({});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    async function* events() {
      yield completedAgentMessage;
      yield completedTurn;
      yield { type: "error", message: "drain failed" };
    }
    const internals = adapter as unknown as {
      translateStream(
        events: AsyncGenerator<unknown>,
        threadId: string,
        runId: string,
        input: Record<string, unknown>,
        isNewThread: boolean,
        subscriber: { next: (event: unknown) => void },
        runCtx: { lastResultData: { isError: boolean } | undefined }
      ): Promise<void>;
    };

    const runCtx: { lastResultData: { isError: boolean } | undefined } = {
      lastResultData: undefined,
    };
    await internals.translateStream(
      events(),
      "thread-1",
      "run-1",
      { messages: [] },
      true,
      { next: vi.fn() },
      runCtx
    );

    // The user already received the agent's reply this turn — a trailing
    // drain-time error must be logged, not reported as a run failure.
    expect(runCtx.lastResultData?.isError).toBe(false);
    expect(errorSpy).toHaveBeenCalledWith(
      "[CodexAdapter] Error while draining after a successful turn:",
      expect.objectContaining({ message: "drain failed" })
    );

    errorSpy.mockRestore();
  });
});
