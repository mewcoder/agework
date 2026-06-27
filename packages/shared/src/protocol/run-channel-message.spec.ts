import { describe, expect, it } from "vitest";
import type { RunChannelMessage } from "./run-channel-message";

describe("RunChannelMessage", () => {
  it("carries runId, monotonic seq, type, payload and ts", () => {
    const message: RunChannelMessage<{ foo: string }> = {
      runId: "run-1",
      seq: 1,
      type: "agui.event",
      payload: { foo: "bar" },
      ts: new Date().toISOString(),
    };

    expect(message.runId).toBe("run-1");
    expect(message.seq).toBe(1);
    expect(message.payload.foo).toBe("bar");
  });
});
