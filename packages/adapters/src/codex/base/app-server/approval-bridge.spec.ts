/**
 * Tests for the ApprovalBridge module.
 */

import {
  ApprovalBridge,
  classifyApprovalMethod,
  type ApprovalInterruptInfo,
  type ApprovalKind,
} from "./approval-bridge";
import { generateId } from "@agework/shared";

describe("classifyApprovalMethod", () => {
  it("returns the correct approval kind for known methods", () => {
    expect(classifyApprovalMethod("item/commandExecution/requestApproval")).toBe("command");
    expect(classifyApprovalMethod("item/fileChange/requestApproval")).toBe("file");
    expect(classifyApprovalMethod("item/permissions/requestApproval")).toBe("permission");
  });

  it("returns null for unknown methods", () => {
    expect(classifyApprovalMethod("item/tool/call")).toBe(null);
    expect(classifyApprovalMethod("unknown")).toBe(null);
  });
});

describe("ApprovalBridge - single-slot pending registry", () => {
  it("registers and retrieves pending approvals", async () => {
    const bridge = new ApprovalBridge();
    const interruptInfo = await bridge.register(
      "item/commandExecution/requestApproval",
      "rpc-1",
      {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        startedAtMs: Date.now(),
        environmentId: null,
        command: "ls -la",
        cwd: "/home/user",
        commandActions: [],
      },
      "agui-thread-1",
    );

    expect(interruptInfo).toEqual({
      interruptId: expect.any(String),
      reason: "confirmation",
      message: expect.stringContaining("ls -la"),
      toolCallId: "item-1",
      metadata: {
        kind: "command",
        method: "item/commandExecution/requestApproval",
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        command: "ls -la",
        cwd: "/home/user",
        availableDecisions: ["accept", "acceptForSession", "decline", "cancel"],
      },
    });

    expect(bridge.hasPending("agui-thread-1")).toBe(true);
    const pending = bridge.getPending("agui-thread-1");
    expect(pending).toBeTruthy();
    expect(pending?.rpcId).toBe("rpc-1");
  });

  it("queues concurrent requests for the same thread", async () => {
    const bridge = new ApprovalBridge();
    const pending1 = await bridge.register(
      "item/commandExecution/requestApproval",
      "rpc-1",
      {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        startedAtMs: Date.now(),
        environmentId: null,
        command: "cmd1",
        cwd: "/home/user",
        commandActions: [],
      },
      "agui-thread-1",
    );

    // Second request is queued
    const pending2Promise = bridge.register(
      "item/fileChange/requestApproval",
      "rpc-2",
      {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-2",
        startedAtMs: Date.now(),
        reason: "write access",
      },
      "agui-thread-1",
    );

    // First is still pending
    expect(bridge.hasPending("agui-thread-1")).toBe(true);
    expect(bridge.getPending("agui-thread-1")?.rpcId).toBe("rpc-1");

    // Resolve the first request → dequeues and registers the second
    bridge.markResolved("agui-thread-1");

    // Second request should now be active
    expect(bridge.hasPending("agui-thread-1")).toBe(true);
    const pending2 = bridge.getPending("agui-thread-1");
    expect(pending2?.rpcId).toBe("rpc-2");
    expect(pending2?.method).toBe("item/fileChange/requestApproval");
  });

  it("clears pending requests", () => {
    const bridge = new ApprovalBridge();

    bridge.markResolved("thread-1");
    expect(bridge.hasPending("thread-1")).toBe(false);
  });

  it("clears all when process exits", () => {
    const bridge = new ApprovalBridge();
    // Simulate some pending state
    (bridge as any).pending.set("thread-1", {} as never);
    (bridge as any).queues.set("thread-1", []);

    bridge.rejectAll();

    expect((bridge as any).pending.size).toBe(0);
    expect((bridge as any).queues.size).toBe(0);
  });

  it("tracks resolved rpcIds for idempotency", () => {
    const bridge = new ApprovalBridge();
    // Simulate a resolved request (internal test - directly mark as resolved)
    (bridge as any).resolvedRpcIds.add("rpc-1");

    expect(bridge.isResolved("rpc-1")).toBe(true);
    expect(bridge.isResolved("rpc-2")).toBe(false);
  });

  it("clears by request id from serverRequest/resolved notification", () => {
    const bridge = new ApprovalBridge();
    // Register a pending (internal test - directly manipulate)
    (bridge as any).pending.set("thread-1", { rpcId: "rpc-1" } as never);

    // serverRequest/resolved arrives
    bridge.clearByRequestId("rpc-1");

    expect(bridge.isResolved("rpc-1")).toBe(true);
    expect(bridge.hasPending("thread-1")).toBe(false);
  });
});

describe("ApprovalBridge - per-thread isolation", () => {
  it("handles approvals for multiple threads independently", async () => {
    const bridge = new ApprovalBridge();

    const info1 = await bridge.register(
      "item/commandExecution/requestApproval",
      "rpc-1",
      {
        threadId: "codex-thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        startedAtMs: Date.now(),
        environmentId: null,
        command: "cmd1",
        cwd: "/home/user",
        commandActions: [],
      },
      "agui-thread-1",
    );

    const info2 = await bridge.register(
      "item/commandExecution/requestApproval",
      "rpc-2",
      {
        threadId: "codex-thread-2",
        turnId: "turn-2",
        itemId: "item-2",
        startedAtMs: Date.now(),
        environmentId: null,
        command: "cmd2",
        cwd: "/home/user",
        commandActions: [],
      },
      "agui-thread-2",
    );

    expect(info1?.metadata.threadId).toBe("codex-thread-1");
    expect(info2?.metadata.threadId).toBe("codex-thread-2");
    expect(bridge.hasPending("agui-thread-1")).toBe(true);
    expect(bridge.hasPending("agui-thread-2")).toBe(true);
  });

  it("clears specific thread without affecting others", () => {
    const bridge = new ApprovalBridge();
    (bridge as any).pending.set("thread-1", {} as never);
    (bridge as any).pending.set("thread-2", {} as never);

    bridge.clearThread("thread-1");

    expect(bridge.hasPending("thread-1")).toBe(false);
    expect(bridge.hasPending("thread-2")).toBe(true);
  });
});