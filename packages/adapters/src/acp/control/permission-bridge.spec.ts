import { describe, it, expect } from "vitest";
import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { AcpPermissionBridge, type AcpPermissionBridgeOptions } from "./permission-bridge";

const tick = () => new Promise((r) => setTimeout(r, 0));

const req = (): RequestPermissionRequest =>
  ({
    sessionId: "s1",
    toolCall: { toolCallId: "call-1", title: "Run a command" },
    options: [
      { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
      { optionId: "reject-once", name: "Reject", kind: "reject_once" },
    ],
  }) as RequestPermissionRequest;

function makeBridge(extra: Partial<AcpPermissionBridgeOptions> = {}) {
  const calls: string[] = [];
  const bridge = new AcpPermissionBridge({
    threadId: "t1",
    emitInterrupt: () => calls.push("interrupt"),
    emitPendingAction: (p) => calls.push(`pending:${p}`),
    emitResumeStart: (r) => calls.push(`resume:${r}`),
    ...extra,
  });
  return { bridge, calls };
}

describe("AcpPermissionBridge", () => {
  it("emits the interrupt before flipping pending action", async () => {
    const { bridge, calls } = makeBridge();
    void bridge.handle(req());
    await tick();
    expect(calls).toEqual(["interrupt", "pending:question"]);
  });

  it("emits resume RUN_STARTED before resolving the request", async () => {
    const { bridge, calls } = makeBridge();
    const p = bridge.handle(req());
    await tick();
    calls.length = 0;

    bridge.resolveControl({
      threadId: "t1",
      answers: { anyKey: "allow-once" },
      resumeRunId: "run-2",
    });
    const res = await p;

    expect(calls).toEqual(["resume:run-2", "pending:null"]);
    expect(res).toEqual({ outcome: { outcome: "selected", optionId: "allow-once" } });
  });

  it("rejects an invalid optionId and keeps the interrupt open", async () => {
    const { bridge } = makeBridge();
    const p = bridge.handle(req());
    await tick();

    expect(bridge.resolveControl({ threadId: "t1", answers: { a: "bogus" } })).toBe(false);
    // still pending → a valid answer now applies
    expect(bridge.resolveControl({ threadId: "t1", answers: { a: "allow-once" } })).toBe(true);
    await p;
  });

  it("processes a duplicate answer only once", async () => {
    const { bridge } = makeBridge();
    const p = bridge.handle(req());
    await tick();
    expect(bridge.resolveControl({ threadId: "t1", answers: { a: "allow-once" } })).toBe(true);
    expect(bridge.resolveControl({ threadId: "t1", answers: { a: "allow-once" } })).toBe(false);
    await p;
  });

  it("serializes concurrent permission requests (one interrupt at a time)", async () => {
    const { bridge, calls } = makeBridge();
    const p1 = bridge.handle(req());
    const p2 = bridge.handle(req());
    await tick();
    expect(calls.filter((c) => c === "interrupt")).toHaveLength(1);

    bridge.resolveControl({ threadId: "t1", answers: { a: "allow-once" } });
    await p1;
    await tick();
    expect(calls.filter((c) => c === "interrupt")).toHaveLength(2);

    bridge.resolveControl({ threadId: "t1", answers: { a: "allow-once" } });
    await p2;
  });

  it("cancel() rejects the pending permission", async () => {
    const { bridge } = makeBridge();
    const p = bridge.handle(req());
    await tick();
    bridge.cancel("stopped");
    await expect(p).rejects.toMatchObject({ code: "ACP_PERMISSION_INVALID" });
  });

  it("times out a permission that is never answered", async () => {
    const { bridge } = makeBridge({ timeoutMs: 20 });
    const p = bridge.handle(req());
    await expect(p).rejects.toMatchObject({ code: "ACP_PERMISSION_TIMEOUT" });
  });
});
