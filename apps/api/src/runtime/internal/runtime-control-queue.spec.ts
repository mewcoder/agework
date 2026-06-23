import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { RuntimeControlQueue } from "./runtime-control-queue";
import type { Envelope, ControlPayload } from "@agework/shared/protocol";

describe("RuntimeControlQueue", () => {
  let queue: RuntimeControlQueue;

  beforeEach(() => {
    queue = new RuntimeControlQueue({
      append: vi.fn().mockResolvedValue({}),
    } as never);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should return empty array for unknown runId", () => {
    const result = queue.poll("nonexistent", 0);
    expect(result).toEqual([]);
  });

  it("should push and poll controls", () => {
    const envelope: Envelope<ControlPayload> = {
      runId: "run-1",
      seq: 1,
      type: "control",
      payload: { type: "cancel", commandId: "cmd-1", runId: "run-1", conversationId: "conversation-1" },
      ts: new Date().toISOString(),
    };

    queue.push("run-1", envelope);
    const result = queue.poll("run-1", 0);
    expect(result).toHaveLength(1);
    expect(result[0].seq).toBe(1);
  });

  it("should only return controls after given seq", () => {
    const e1: Envelope<ControlPayload> = {
      runId: "run-1", seq: 1, type: "control",
      payload: { type: "cancel", commandId: "cmd-1", runId: "run-1", conversationId: "conversation-1" },
      ts: "",
    };
    const e2: Envelope<ControlPayload> = {
      runId: "run-1", seq: 2, type: "control",
      payload: { type: "cancel", commandId: "cmd-2", runId: "run-1", conversationId: "conversation-1" },
      ts: "",
    };

    queue.push("run-1", e1);
    queue.push("run-1", e2);

    const result = queue.poll("run-1", 1);
    expect(result).toHaveLength(1);
    expect(result[0].seq).toBe(2);
  });

  it("should cleanup a run's queue", () => {
    const envelope: Envelope<ControlPayload> = {
      runId: "run-1", seq: 1, type: "control",
      payload: { type: "cancel", commandId: "cmd-1", runId: "run-1", conversationId: "conversation-1" },
      ts: "",
    };
    queue.push("run-1", envelope);
    queue.cleanup("run-1");
    expect(queue.poll("run-1", 0)).toEqual([]);
  });

  it("should resolve a workspace waiter when a matching control is pushed", async () => {
    const pending = queue.waitForWorkspace("ws-1", 0, 1_000);
    const envelope: Envelope<ControlPayload> = {
      runId: "run-1", seq: 1, type: "control",
      payload: { type: "cancel", commandId: "cmd-1", runId: "run-1", conversationId: "conversation-1" },
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
