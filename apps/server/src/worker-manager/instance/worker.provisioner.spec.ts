import { describe, it, expect, vi } from "vitest";
import { WorkerProvisioner } from "./worker.provisioner";

function deps() {
  return {
    runtime: {
      prepareEnvironment: vi
        .fn()
        .mockResolvedValue({ runtimeInstanceId: "c1" }),
      launchWorker: vi.fn().mockResolvedValue({ runtimeInstanceId: "c1" }),
      teardown: vi.fn().mockResolvedValue(undefined),
    },
    registry: {
      insertStarting: vi.fn().mockResolvedValue({ ok: true }),
      upsertRunning: vi.fn().mockResolvedValue(undefined),
      markErrorByOwner: vi.fn().mockResolvedValue(undefined),
      markStoppedByOwner: vi.fn().mockResolvedValue(undefined),
    },
    handshake: {
      waitForRegister: vi.fn().mockResolvedValue({ pid: 1, registeredAt: "t" }),
      cancel: vi.fn(),
    },
    dispatcher: { cleanupByOwnerId: vi.fn() },
    config: { getLaunchTimeoutSeconds: () => 30 },
  };
}

const input = (runId = "run-1") =>
  ({
    runConfig: { runId, workspaceId: "ws-1", conversationId: "c" },
    runtimeTarget: {
      runtimeType: "local",
      ownerId: "ws-1",
      userId: "u1",
      workspaceId: "ws-1",
      hostPath: "/w",
      runtimePath: "/w",
      runtimeLogDir: "/logs",
    },
  }) as any;

function make(d = deps()) {
  return new WorkerProvisioner(
    d.runtime as any,
    d.registry as any,
    d.handshake as any,
    d.dispatcher as any,
    d.config as any
  );
}

describe("WorkerProvisioner", () => {
  it("runs insertStarting → prepare → launch → waitForRegister → upsertRunning and returns ready", async () => {
    const d = deps();
    const res = await make(d).acquireInstanceForRun(input());
    expect(d.registry.insertStarting).toHaveBeenCalledOnce();
    expect(d.runtime.prepareEnvironment).toHaveBeenCalledOnce();
    expect(d.runtime.launchWorker).toHaveBeenCalledOnce();
    expect(d.handshake.waitForRegister).toHaveBeenCalledOnce();
    expect(d.registry.upsertRunning).toHaveBeenCalledOnce();
    expect(res).toEqual({ outcome: "ready", runtimeInstanceId: "c1" });
  });

  it("dedups concurrent runs for the same owner to one launch", async () => {
    const d = deps();
    const p = make(d);
    const [a, b] = await Promise.all([
      p.acquireInstanceForRun(input("r1")),
      p.acquireInstanceForRun(input("r2")),
    ]);
    expect(a).toEqual({ outcome: "ready", runtimeInstanceId: "c1" });
    expect(b).toEqual({ outcome: "ready", runtimeInstanceId: "c1" });
    expect(d.runtime.prepareEnvironment).toHaveBeenCalledOnce();
  });

  it("returns error and marks error when launch fails", async () => {
    const d = deps();
    d.runtime.prepareEnvironment.mockRejectedValueOnce(new Error("boom"));
    const res = await make(d).acquireInstanceForRun(input());
    expect(res.outcome).toBe("error");
    expect(d.registry.markErrorByOwner).toHaveBeenCalledOnce();
  });

  it("reuses an existing running row on insertStarting conflict", async () => {
    const d = deps();
    d.registry.insertStarting.mockResolvedValueOnce({
      ok: false,
      existing: { runtimeInstanceId: "old", status: "running" },
    });
    const res = await make(d).acquireInstanceForRun(input());
    expect(res).toEqual({ outcome: "ready", runtimeInstanceId: "old" });
    expect(d.runtime.prepareEnvironment).not.toHaveBeenCalled();
  });
});
