import { describe, it, expect, vi } from "vitest";
import { WorkerProvisioner } from "./worker.provisioner";

function deps() {
  return {
    runtime: {
      start: vi.fn().mockResolvedValue({ runtimeInstanceId: "c1" }),
      stop: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn().mockResolvedValue(undefined),
    },
    registry: {
      insertStarting: vi.fn().mockResolvedValue({ ok: true }),
      upsertRunning: vi.fn().mockResolvedValue(undefined),
      markErrorByOwner: vi.fn().mockResolvedValue(undefined),
      markStoppedByOwner: vi.fn().mockResolvedValue(undefined),
      isRuntimeInstanceBoundToWorkspace: vi.fn().mockResolvedValue(true),
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

const dockerInput = (runId = "run-1") =>
  ({
    runConfig: { runId, workspaceId: "ws-1", conversationId: "c" },
    runtimeTarget: {
      runtimeType: "docker",
      ownerId: "user-1",
      userId: "user-1",
      workspaceId: "ws-1",
      hostPath: "/w",
      runtimePath: "/w",
      runtimeLogDir: "/logs",
      sandbox: {
        isolationScope: "user",
        mountTarget: "/workspaces",
      },
    },
  }) as any;

function make(d = deps()) {
  return new WorkerProvisioner(
    { runtimeFor: () => d.runtime } as any,
    d.registry as any,
    d.handshake as any,
    d.dispatcher as any,
    d.config as any
  );
}

describe("WorkerProvisioner", () => {
  it("runs insertStarting → start → waitForRegister → upsertRunning and returns ready", async () => {
    const d = deps();
    const res = await make(d).acquireInstanceForRun(input());
    expect(d.registry.insertStarting).toHaveBeenCalledOnce();
    expect(d.runtime.start).toHaveBeenCalledOnce();
    expect(d.handshake.waitForRegister).toHaveBeenCalledOnce();
    expect(d.registry.upsertRunning).toHaveBeenCalledOnce();
    expect(res).toEqual({ outcome: "ready", runtimeInstanceId: "c1" });
  });

  it("routes a docker runtimeTarget by reading isolationScope from target.sandbox (not defaulted to 'workspace')", async () => {
    const d = deps();
    await make(d).acquireInstanceForRun(dockerInput());
    const ctx = d.runtime.start.mock.calls[0][0];
    expect(ctx.runtimeType).toBe("docker");
    expect(d.registry.insertStarting).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeType: "docker",
        isolationScope: "user",
      }),
      expect.any(String),
      "http",
      expect.any(String)
    );
  });

  it("threads a ctx.isExpectedRuntimeInstance that delegates to registry.isRuntimeInstanceBoundToWorkspace", async () => {
    const d = deps();
    await make(d).acquireInstanceForRun(input());
    const ctx = d.runtime.start.mock.calls[0][0];
    expect(typeof ctx.isExpectedRuntimeInstance).toBe("function");

    await ctx.isExpectedRuntimeInstance("runtime-instance-1");
    expect(d.registry.isRuntimeInstanceBoundToWorkspace).toHaveBeenCalledWith(
      "local",
      "ws-1",
      "runtime-instance-1"
    );
  });

  it("threads a ctx.onWorkerExit that clears the owner map and marks the registry row stopped", async () => {
    const d = deps();
    const p = make(d);
    await p.acquireInstanceForRun(input());
    const ctx = d.runtime.start.mock.calls[0][0];
    expect(typeof ctx.onWorkerExit).toBe("function");

    ctx.onWorkerExit();
    expect(d.registry.markStoppedByOwner).toHaveBeenCalledWith(
      "local",
      "workspace",
      "ws-1"
    );

    // owner map cleared → next acquire launches fresh instead of reusing "ready"
    d.runtime.start.mockClear();
    await p.acquireInstanceForRun(input("r2"));
    expect(d.runtime.start).toHaveBeenCalledOnce();
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
    expect(d.runtime.start).toHaveBeenCalledOnce();
  });

  it("returns error and marks error when launch fails", async () => {
    const d = deps();
    d.runtime.start.mockRejectedValueOnce(new Error("boom"));
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
    expect(d.runtime.start).not.toHaveBeenCalled();
  });

  it("clears the owner entry when insertStarting throws, so a retry can start fresh", async () => {
    const d = deps();
    d.registry.insertStarting.mockRejectedValueOnce(new Error("db down"));
    const p = make(d);

    const res = await p.acquireInstanceForRun(input());
    expect(res.outcome).toBe("error");

    const res2 = await p.acquireInstanceForRun(input("r2"));
    expect(res2).toEqual({ outcome: "ready", runtimeInstanceId: "c1" });
    expect(d.registry.insertStarting).toHaveBeenCalledTimes(2);
    expect(d.runtime.start).toHaveBeenCalledOnce();
  });
});
