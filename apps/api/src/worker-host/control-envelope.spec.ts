import { describe, it, expect } from "vitest";
import { nextControlEnvelope } from "./control-envelope";
import type { ControlPayload } from "@agework/shared/protocol";

const cancelControl: ControlPayload = {
  type: "cancel",
  commandId: "cmd-1",
  runId: "run-1",
  conversationId: "conv-1",
};

describe("nextControlEnvelope", () => {
  it("creates envelope with seq starting at 1", () => {
    const seqs = new Map<string, number>();
    const result = nextControlEnvelope(seqs, "ws-1", "run-1", cancelControl);

    expect(result).toMatchObject({
      runId: "run-1",
      seq: 1,
      type: "control",
      payload: { type: "cancel" },
    });
    expect(result.ts).toBeTruthy();
  });

  it("increments seq for the same scope key", () => {
    const seqs = new Map<string, number>();
    nextControlEnvelope(seqs, "ws-1", "run-1", cancelControl);
    const second = nextControlEnvelope(seqs, "ws-1", "run-2", cancelControl);
    expect(second.seq).toBe(2);
  });

  it("uses independent seq counters for different scope keys", () => {
    const seqs = new Map<string, number>();
    const a = nextControlEnvelope(seqs, "ws-1", "run-1", cancelControl);
    const b = nextControlEnvelope(seqs, "ws-2", "run-2", cancelControl);
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(1);
  });
});
