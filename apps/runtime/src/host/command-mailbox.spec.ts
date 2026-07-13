import { describe, it, expect, vi } from "vitest";
import type { CommandPayload, RunChannelMessage } from "@agework/shared/protocol";
import { CommandMailbox } from "./command-mailbox.js";

function makeCommand(seq: number, runId = "run-1"): RunChannelMessage<CommandPayload> {
  return {
    runId,
    seq,
    type: "command",
    payload: { type: "cancel", commandId: `cmd-${seq}`, runId } as CommandPayload,
    ts: "t",
  };
}

describe("CommandMailbox", () => {
  it("pollImmediate returns only commands after afterSeq", () => {
    const mailbox = new CommandMailbox();
    mailbox.push("worker-1", makeCommand(1));
    mailbox.push("worker-1", makeCommand(2));

    expect(mailbox.pollImmediate("worker-1", 1).map((c) => c.seq)).toEqual([2]);
  });

  it("poll resolves a pending waiter when a command arrives (long-poll)", async () => {
    const mailbox = new CommandMailbox();
    const pending = mailbox.poll("worker-1", 0, 5000);

    mailbox.push("worker-1", makeCommand(1));

    await expect(pending).resolves.toHaveLength(1);
  });

  it("poll resolves empty after the timeout when nothing arrives", async () => {
    vi.useFakeTimers();
    try {
      const mailbox = new CommandMailbox();
      const pending = mailbox.poll("worker-1", 0, 50);
      await vi.advanceTimersByTimeAsync(60);
      await expect(pending).resolves.toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cleanup releases pending waiters and drops the queue", async () => {
    const mailbox = new CommandMailbox();
    const pending = mailbox.poll("worker-1", 0, 5000);

    mailbox.cleanup("worker-1");

    await expect(pending).resolves.toEqual([]);
    expect(mailbox.pollImmediate("worker-1", 0)).toEqual([]);
  });

  it("epochFor is stable per worker within a process lifetime", () => {
    const mailbox = new CommandMailbox();
    const first = mailbox.epochFor("worker-1");

    expect(mailbox.epochFor("worker-1")).toBe(first);
    // cleanup 后重新生成(worker 察觉 epoch 变化会重置 afterSeq)
    mailbox.cleanup("worker-1");
    expect(mailbox.epochFor("worker-1")).toBeGreaterThanOrEqual(first);
  });

  it("isolates queues between workers", () => {
    const mailbox = new CommandMailbox();
    mailbox.push("worker-1", makeCommand(1));

    expect(mailbox.pollImmediate("worker-2", 0)).toEqual([]);
  });
});
