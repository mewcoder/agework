import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { RuntimeCommandQueue } from "./command-queue";
import type { Envelope, CommandPayload } from "@agework/shared/protocol";

describe("RuntimeCommandQueue", () => {
  let queue: RuntimeCommandQueue;

  beforeEach(() => {
    queue = new RuntimeCommandQueue();
    queue.setCommandSentRecorder({
      recordCommandSent: vi.fn().mockResolvedValue(undefined),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should return empty array for unknown ownerId", () => {
    const result = queue.pollByOwnerId("nonexistent", 0);
    expect(result).toEqual([]);
  });

  it("should push and poll owner commands", () => {
    const envelope: Envelope<CommandPayload> = {
      runId: "run-1",
      seq: 1,
      type: "command",
      payload: {
        type: "cancel",
        commandId: "cmd-1",
        runId: "run-1",
        conversationId: "conversation-1",
      },
      ts: new Date().toISOString(),
    };

    queue.pushByOwnerId("owner-1", envelope);
    const result = queue.pollByOwnerId("owner-1", 0);
    expect(result).toHaveLength(1);
    expect(result[0].seq).toBe(1);
  });

  it("should only return owner commands after given seq", () => {
    const e1: Envelope<CommandPayload> = {
      runId: "run-1",
      seq: 1,
      type: "command",
      payload: {
        type: "cancel",
        commandId: "cmd-1",
        runId: "run-1",
        conversationId: "conversation-1",
      },
      ts: "",
    };
    const e2: Envelope<CommandPayload> = {
      runId: "run-1",
      seq: 2,
      type: "command",
      payload: {
        type: "cancel",
        commandId: "cmd-2",
        runId: "run-1",
        conversationId: "conversation-1",
      },
      ts: "",
    };

    queue.pushByOwnerId("owner-1", e1);
    queue.pushByOwnerId("owner-1", e2);

    const result = queue.pollByOwnerId("owner-1", 1);
    expect(result).toHaveLength(1);
    expect(result[0].seq).toBe(2);
  });

  it("should cleanup an owner's queue", () => {
    const envelope: Envelope<CommandPayload> = {
      runId: "run-1",
      seq: 1,
      type: "command",
      payload: {
        type: "cancel",
        commandId: "cmd-1",
        runId: "run-1",
        conversationId: "conversation-1",
      },
      ts: "",
    };
    queue.pushByOwnerId("owner-1", envelope);
    queue.cleanupByOwnerId("owner-1");
    expect(queue.pollByOwnerId("owner-1", 0)).toEqual([]);
  });

  it("should resolve an owner waiter when a matching command is pushed", async () => {
    const pending = queue.waitForOwnerId("owner-1", 0, 1_000);
    const envelope: Envelope<CommandPayload> = {
      runId: "run-1",
      seq: 1,
      type: "command",
      payload: {
        type: "cancel",
        commandId: "cmd-1",
        runId: "run-1",
        conversationId: "conversation-1",
      },
      ts: "",
    };

    queue.pushByOwnerId("owner-1", envelope);

    await expect(pending).resolves.toEqual([envelope]);
  });

  it("should resolve an owner waiter with empty commands on timeout", async () => {
    vi.useFakeTimers();

    const pending = queue.waitForOwnerId("owner-1", 0, 1_000);
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(pending).resolves.toEqual([]);
  });
});
