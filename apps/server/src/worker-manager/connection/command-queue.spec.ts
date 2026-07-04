import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { WorkerCommandQueue } from "./command-queue";
import type {
  RunChannelMessage,
  CommandPayload,
} from "@agework/shared/protocol";

describe("WorkerCommandQueue", () => {
  let queue: WorkerCommandQueue;

  beforeEach(() => {
    queue = new WorkerCommandQueue();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should return empty array for unknown ownerId", () => {
    const result = queue.pollByOwnerId("nonexistent", 0);
    expect(result).toEqual([]);
  });

  it("should push and poll owner commands", () => {
    const message: RunChannelMessage<CommandPayload> = {
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

    queue.pushByOwnerId("owner-1", message);
    const result = queue.pollByOwnerId("owner-1", 0);
    expect(result).toHaveLength(1);
    expect(result[0].seq).toBe(1);
  });

  it("should only return owner commands after given seq", () => {
    const e1: RunChannelMessage<CommandPayload> = {
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
    const e2: RunChannelMessage<CommandPayload> = {
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
    const message: RunChannelMessage<CommandPayload> = {
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
    queue.pushByOwnerId("owner-1", message);
    queue.cleanupByOwnerId("owner-1");
    expect(queue.pollByOwnerId("owner-1", 0)).toEqual([]);
  });

  it("should resolve an owner waiter when a matching command is pushed", async () => {
    const pending = queue.waitForOwnerId("owner-1", 0, 1_000);
    const message: RunChannelMessage<CommandPayload> = {
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

    queue.pushByOwnerId("owner-1", message);

    await expect(pending).resolves.toEqual([message]);
  });

  it("should resolve an owner waiter with empty commands on timeout", async () => {
    vi.useFakeTimers();

    const pending = queue.waitForOwnerId("owner-1", 0, 1_000);
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(pending).resolves.toEqual([]);
  });

  it("drains all pending waiters with empty commands on application shutdown", async () => {
    const a = queue.waitForOwnerId("owner-1", 0, 60_000);
    const b = queue.waitForOwnerId("owner-2", 0, 60_000);

    queue.onApplicationShutdown();

    await expect(a).resolves.toEqual([]);
    await expect(b).resolves.toEqual([]);
  });

  describe("epochFor()", () => {
    it("returns the same value across repeated calls for the same ownerId", () => {
      const first = queue.epochFor("owner-1");
      const second = queue.epochFor("owner-1");
      expect(second).toBe(first);
    });

    it("returns independent values for different ownerIds", () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000);
      const owner1Epoch = queue.epochFor("owner-1");
      vi.setSystemTime(2_000);
      const owner2Epoch = queue.epochFor("owner-2");

      expect(owner1Epoch).not.toBe(owner2Epoch);
      // 各自的值在重复调用后依然稳定，互不影响
      expect(queue.epochFor("owner-1")).toBe(owner1Epoch);
      expect(queue.epochFor("owner-2")).toBe(owner2Epoch);
    });

    it("issues a new epoch after cleanupByOwnerId", () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000);
      const beforeCleanup = queue.epochFor("owner-1");

      queue.cleanupByOwnerId("owner-1");
      vi.setSystemTime(2_000);
      const afterCleanup = queue.epochFor("owner-1");

      expect(afterCleanup).not.toBe(beforeCleanup);
    });
  });
});
