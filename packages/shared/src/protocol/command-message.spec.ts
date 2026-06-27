import { describe, it, expect } from "vitest";
import { nextCommandMessage } from "./index";
import type { CommandPayload } from "./channel";

const cancelCommand: CommandPayload = {
  type: "cancel",
  commandId: "cmd-1",
  runId: "run-1",
  conversationId: "conv-1",
};

describe("nextCommandMessage", () => {
  it("creates message with seq starting at 1", () => {
    const seqs = new Map<string, number>();
    const result = nextCommandMessage(seqs, "ws-1", "run-1", cancelCommand);

    expect(result).toMatchObject({
      runId: "run-1",
      seq: 1,
      type: "command",
      payload: { type: "cancel" },
    });
    expect(result.ts).toBeTruthy();
  });

  it("increments seq for the same owner", () => {
    const seqs = new Map<string, number>();
    nextCommandMessage(seqs, "ws-1", "run-1", cancelCommand);
    const second = nextCommandMessage(seqs, "ws-1", "run-2", cancelCommand);
    expect(second.seq).toBe(2);
  });

  it("uses independent seq counters for different owners", () => {
    const seqs = new Map<string, number>();
    const a = nextCommandMessage(seqs, "ws-1", "run-1", cancelCommand);
    const b = nextCommandMessage(seqs, "ws-2", "run-2", cancelCommand);
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(1);
  });
});
