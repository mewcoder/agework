import { describe, expect, it } from "vitest";
import { AgentRunOutcome } from "./agent-run-outcome.js";

describe("AgentRunOutcome", () => {
  it("keeps RUN_ERROR terminal when the adapter completes its stream", () => {
    const outcome = new AgentRunOutcome();

    outcome.observe({ type: "RUN_ERROR", message: "provider failed" });

    expect(outcome.onComplete(false)).toEqual({
      status: "error",
      error: "provider failed",
    });
  });

  it("maps a normal stream completion to finished", () => {
    const outcome = new AgentRunOutcome();

    outcome.observe({ type: "RUN_FINISHED" });

    expect(outcome.onComplete(false)).toEqual({ status: "finished" });
  });

  it("lets an explicit stop win over an observed provider error", () => {
    const outcome = new AgentRunOutcome();

    outcome.observe({ type: "RUN_ERROR", message: "aborted" });

    expect(outcome.onComplete(true)).toEqual({ status: "cancelled" });
  });

  it("uses a stable fallback when RUN_ERROR has no message", () => {
    const outcome = new AgentRunOutcome();

    outcome.observe({ type: "RUN_ERROR" });

    expect(outcome.onComplete(false)).toEqual({
      status: "error",
      error: "agent run failed",
    });
  });
});
