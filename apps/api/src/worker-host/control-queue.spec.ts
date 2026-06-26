import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { RuntimeControlQueue } from "./control-queue";
import type { Envelope, ControlPayload } from "@agework/shared/protocol";

describe("RuntimeControlQueue", () => {
  let queue: RuntimeControlQueue;

  beforeEach(() => {
    queue = new RuntimeControlQueue();
    queue.setControlSentRecorder({
      recordControlSent: vi.fn().mockResolvedValue(undefined),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should return empty array for unknown workspaceId", () => {
    const result = queue.pollByWorkspace("nonexistent", 0);
    expect(result).toEqual([]);
  });

  it("should push and poll workspace controls", () => {
    const envelope: Envelope<ControlPayload> = {
      runId: "run-1",
      seq: 1,
      type: "control",
      payload: {
        type: "cancel",
        commandId: "cmd-1",
        runId: "run-1",
        conversationId: "conversation-1",
      },
      ts: new Date().toISOString(),
    };

    queue.pushForWorkspace("ws-1", envelope);
    const result = queue.pollByWorkspace("ws-1", 0);
    expect(result).toHaveLength(1);
    expect(result[0].seq).toBe(1);
  });

  it("should only return workspace controls after given seq", () => {
    const e1: Envelope<ControlPayload> = {
      runId: "run-1",
      seq: 1,
      type: "control",
      payload: {
        type: "cancel",
        commandId: "cmd-1",
        runId: "run-1",
        conversationId: "conversation-1",
      },
      ts: "",
    };
    const e2: Envelope<ControlPayload> = {
      runId: "run-1",
      seq: 2,
      type: "control",
      payload: {
        type: "cancel",
        commandId: "cmd-2",
        runId: "run-1",
        conversationId: "conversation-1",
      },
      ts: "",
    };

    queue.pushForWorkspace("ws-1", e1);
    queue.pushForWorkspace("ws-1", e2);

    const result = queue.pollByWorkspace("ws-1", 1);
    expect(result).toHaveLength(1);
    expect(result[0].seq).toBe(2);
  });

  it("should cleanup a workspace's queue", () => {
    const envelope: Envelope<ControlPayload> = {
      runId: "run-1",
      seq: 1,
      type: "control",
      payload: {
        type: "cancel",
        commandId: "cmd-1",
        runId: "run-1",
        conversationId: "conversation-1",
      },
      ts: "",
    };
    queue.pushForWorkspace("ws-1", envelope);
    queue.cleanupWorkspace("ws-1");
    expect(queue.pollByWorkspace("ws-1", 0)).toEqual([]);
  });

  it("should resolve a workspace waiter when a matching control is pushed", async () => {
    const pending = queue.waitForWorkspace("ws-1", 0, 1_000);
    const envelope: Envelope<ControlPayload> = {
      runId: "run-1",
      seq: 1,
      type: "control",
      payload: {
        type: "cancel",
        commandId: "cmd-1",
        runId: "run-1",
        conversationId: "conversation-1",
      },
      ts: "",
    };

    queue.pushForWorkspace("ws-1", envelope);

    await expect(pending).resolves.toEqual([envelope]);
  });

  it("should resolve a workspace waiter with empty controls on timeout", async () => {
    vi.useFakeTimers();

    const pending = queue.waitForWorkspace("ws-1", 0, 1_000);
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(pending).resolves.toEqual([]);
  });
});
