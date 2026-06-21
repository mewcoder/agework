
import { CodexRunLogger } from "./codex-run-logger";

describe("CodexRunLogger", () => {
  function createLogger(nowValues: number[]) {
    const messages: string[] = [];
    const now = vi.fn(() => {
      const next = nowValues.shift();
      if (next === undefined) throw new Error("missing test timestamp");
      return next;
    });

    return {
      messages,
      now,
      logger: {
        log: (message: string) => messages.push(message),
        warn: (message: string) => messages.push(message),
        error: (message: string) => messages.push(message),
      },
    };
  }

  it("logs run checkpoints with elapsed and delta timings", () => {
    const { logger, messages, now } = createLogger([
      1_700_000_000_000, 1_700_000_000_000, 1_700_000_000_300,
      1_700_000_001_100,
    ]);
    const runLogger = new CodexRunLogger({
      logger,
      now,
      threadId: "thread-1",
      runId: "run-1",
    });

    runLogger.runStarted();
    runLogger.checkpoint("server.ready");
    runLogger.checkpoint("turn.started", { turn: "turn-1" });

    expect(messages).toEqual([
      "[CodexAgent] 2023-11-14T22:13:20.000Z run.started thread=thread-1 run=run-1 +0ms delta=0ms",
      "[CodexAgent] 2023-11-14T22:13:20.300Z server.ready thread=thread-1 run=run-1 +300ms delta=300ms",
      "[CodexAgent] 2023-11-14T22:13:21.100Z turn.started thread=thread-1 run=run-1 turn=turn-1 +1100ms delta=800ms",
    ]);
  });

  it("logs first notification and first visible event only once", () => {
    const { logger, messages, now } = createLogger([
      1_700_000_000_000, 1_700_000_000_010, 1_700_000_000_020,
    ]);
    const runLogger = new CodexRunLogger({ logger, now, threadId: "thread-1" });

    runLogger.firstNotification("item/started");
    runLogger.firstNotification("item/completed");
    runLogger.firstVisibleEvent("REASONING_START");
    runLogger.firstVisibleEvent("TEXT_MESSAGE_START");

    expect(messages).toEqual([
      "[CodexAgent] 2023-11-14T22:13:20.010Z first.notification thread=thread-1 method=item/started +10ms delta=10ms",
      "[CodexAgent] 2023-11-14T22:13:20.020Z first.visible_event thread=thread-1 type=REASONING_START +20ms delta=10ms",
    ]);
  });
});
