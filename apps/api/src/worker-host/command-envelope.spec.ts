import { describe, it, expect } from "vitest";
import { nextCommandEnvelope } from "./command-envelope";
import type { ControlPayload } from "@agework/shared/protocol";

const cancelControl: ControlPayload = {
  type: "cancel",
  commandId: "cmd-1",
  runId: "run-1",
  conversationId: "conv-1",
};

describe("nextCommandEnvelope", () => {
  it("creates envelope with seq starting at 1", () => {
    const seqs = new Map<string, number>();
    const result = nextCommandEnvelope(seqs, "ws-1", "run-1", cancelControl);

    expect(result).toMatchObject({
      runId: "run-1",
      seq: 1,
      type: "control",
      payload: { type: "cancel" },
    });
    expect(result.ts).toBeTruthy();
  });

  it("increments seq for the same owner", () => {
    const seqs = new Map<string, number>();
    nextCommandEnvelope(seqs, "ws-1", "run-1", cancelControl);
    const second = nextCommandEnvelope(seqs, "ws-1", "run-2", cancelControl);
    expect(second.seq).toBe(2);
  });

  it("uses independent seq counters for different owners", () => {
    const seqs = new Map<string, number>();
    const a = nextCommandEnvelope(seqs, "ws-1", "run-1", cancelControl);
    const b = nextCommandEnvelope(seqs, "ws-2", "run-2", cancelControl);
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(1);
  });
});
