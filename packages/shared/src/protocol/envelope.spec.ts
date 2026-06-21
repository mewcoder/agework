import type { Envelope } from "./envelope";

describe("Envelope", () => {
  it("carries runId, monotonic seq, type, payload and ts", () => {
    const envelope: Envelope<{ foo: string }> = {
      runId: "run-1",
      seq: 1,
      type: "agui.event",
      payload: { foo: "bar" },
      ts: new Date().toISOString(),
    };

    expect(envelope.runId).toBe("run-1");
    expect(envelope.seq).toBe(1);
    expect(envelope.payload.foo).toBe("bar");
  });
});
