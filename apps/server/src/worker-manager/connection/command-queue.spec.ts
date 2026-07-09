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

  it("should return empty array for unknown workerId", () => {
    const result = queue.pollByWorkerId("nonexistent", 0);
    expect(result).toEqual([]);
  });

  it("should push and poll worker commands", () => {
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

    queue.pushByWorkerId("worker-1", message);
    const result = queue.pollByWorkerId("worker-1", 0);
    expect(result).toHaveLength(1);
    expect(result[0].seq).toBe(1);
  });

  it("should only return worker commands after given seq", () => {
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

    queue.pushByWorkerId("worker-1", e1);
    queue.pushByWorkerId("worker-1", e2);

    const result = queue.pollByWorkerId("worker-1", 1);
    expect(result).toHaveLength(1);
    expect(result[0].seq).toBe(2);
  });

  it("should cleanup a worker's queue", () => {
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
    queue.pushByWorkerId("worker-1", message);
    queue.cleanupByWorkerId("worker-1");
    expect(queue.pollByWorkerId("worker-1", 0)).toEqual([]);
  });

  it("should resolve a worker waiter when a matching command is pushed", async () => {
    const pending = queue.waitForWorkerId("worker-1", 0, 1_000);
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

    queue.pushByWorkerId("worker-1", message);

    await expect(pending).resolves.toEqual([message]);
  });

  it("should resolve a worker waiter with empty commands on timeout", async () => {
    vi.useFakeTimers();

    const pending = queue.waitForWorkerId("worker-1", 0, 1_000);
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(pending).resolves.toEqual([]);
  });

  it("drains all pending waiters with empty commands on application shutdown", async () => {
    const a = queue.waitForWorkerId("worker-1", 0, 60_000);
    const b = queue.waitForWorkerId("worker-2", 0, 60_000);

    queue.onApplicationShutdown();

    await expect(a).resolves.toEqual([]);
    await expect(b).resolves.toEqual([]);
  });

  describe("epochFor()", () => {
    it("returns the same value across repeated calls for the same workerId", () => {
      const first = queue.epochFor("worker-1");
      const second = queue.epochFor("worker-1");
      expect(second).toBe(first);
    });

    it("returns independent values for different workerIds", () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000);
      const worker1Epoch = queue.epochFor("worker-1");
      vi.setSystemTime(2_000);
      const worker2Epoch = queue.epochFor("worker-2");

      expect(worker1Epoch).not.toBe(worker2Epoch);
      // 各自的值在重复调用后依然稳定，互不影响
      expect(queue.epochFor("worker-1")).toBe(worker1Epoch);
      expect(queue.epochFor("worker-2")).toBe(worker2Epoch);
    });

    it("issues a new epoch after cleanupByWorkerId", () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000);
      const beforeCleanup = queue.epochFor("worker-1");

      queue.cleanupByWorkerId("worker-1");
      vi.setSystemTime(2_000);
      const afterCleanup = queue.epochFor("worker-1");

      expect(afterCleanup).not.toBe(beforeCleanup);
    });
  });
});
