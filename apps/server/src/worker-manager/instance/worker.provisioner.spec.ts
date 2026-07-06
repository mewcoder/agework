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
      findBindingWithResource: vi.fn().mockResolvedValue(null),
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
    targetRuntimeId: "builtin-local",
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
    targetRuntimeId: "builtin-docker",
  }) as any;

function make(d = deps()) {
  const runtimeFor = vi.fn().mockReturnValue(d.runtime);
  return {
    provisioner: new WorkerProvisioner(
      { runtimeFor } as any,
      d.registry as any,
      d.handshake as any,
      d.dispatcher as any,
      d.config as any
    ),
    runtimeFor,
  };
}

describe("WorkerProvisioner", () => {
  it("runs insertStarting → start → waitForRegister → upsertRunning and returns ready", async () => {
    const d = deps();
    const res = await make(d).provisioner.acquireInstanceForRun(input());
    expect(d.registry.insertStarting).toHaveBeenCalledOnce();
    expect(d.runtime.start).toHaveBeenCalledOnce();
    expect(d.handshake.waitForRegister).toHaveBeenCalledOnce();
    expect(d.registry.upsertRunning).toHaveBeenCalledOnce();
    expect(res).toEqual({ outcome: "ready", runtimeInstanceId: "c1" });
  });

  describe("targetRuntimeId routing", () => {
    it("routes start() to runtimeFor(targetRuntimeId) for a Managed run (builtin id)", async () => {
      const d = deps();
      const { provisioner, runtimeFor } = make(d);
      await provisioner.acquireInstanceForRun(input());
      expect(runtimeFor).toHaveBeenCalledWith("builtin-local");
    });

    it("routes start() to runtimeFor(targetRuntimeId) for a Registered run", async () => {
      const d = deps();
      const { provisioner, runtimeFor } = make(d);
      await provisioner.acquireInstanceForRun({
        ...input(),
        targetRuntimeId: "rt-1",
      });
      expect(runtimeFor).toHaveBeenCalledWith("rt-1");
      expect(d.registry.insertStarting).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(String),
        "http",
        expect.any(String),
        "rt-1"
      );
    });

    it("stop() routes to runtimeFor(ref.targetRuntimeId)", async () => {
      const d = deps();
      const { provisioner, runtimeFor } = make(d);
      await provisioner.stop({
        runtimeType: "docker",
        ownerId: "owner-1",
        runtimeInstanceId: "c1",
        isolationScope: "workspace",
        targetRuntimeId: "rt-1",
      });
      expect(runtimeFor).toHaveBeenCalledWith("rt-1");
      expect(d.runtime.stop).toHaveBeenCalledOnce();
    });

    it("destroy() routes to runtimeFor(ref.targetRuntimeId) for a Managed ref (builtin id)", async () => {
      const d = deps();
      const { provisioner, runtimeFor } = make(d);
      await provisioner.destroy({
        runtimeType: "local",
        ownerId: "owner-1",
        runtimeInstanceId: "1234:token",
        isolationScope: "workspace",
        targetRuntimeId: "builtin-local",
      });
      expect(runtimeFor).toHaveBeenCalledWith("builtin-local");
      expect(d.runtime.destroy).toHaveBeenCalledOnce();
    });

    it("destroy() swallows a missing targetRuntimeId but still cleans up the registry row (server-constructed refs should always have one)", async () => {
      const d = deps();
      const { provisioner } = make(d);
      await expect(
        provisioner.destroy({
          runtimeType: "local",
          ownerId: "owner-1",
          runtimeInstanceId: "1234:token",
          isolationScope: "workspace",
        })
      ).resolves.toBeUndefined();
      // finalize() swallows the teardown error and still tears down the registry row
      expect(d.registry.markStoppedByOwner).toHaveBeenCalledWith(
        "local",
        "workspace",
        "owner-1"
      );
      expect(d.runtime.destroy).not.toHaveBeenCalled();
    });
  });

  it("routes a docker runtimeTarget by reading isolationScope from target.sandbox (not defaulted to 'workspace')", async () => {
    const d = deps();
    await make(d).provisioner.acquireInstanceForRun(dockerInput());
    const ctx = d.runtime.start.mock.calls[0][0];
    expect(ctx.runtimeType).toBe("docker");
    expect(d.registry.insertStarting).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeType: "docker",
        isolationScope: "user",
      }),
      expect.any(String),
      "http",
      expect.any(String),
      "builtin-docker"
    );
  });

  it("sets ctx.expectedRuntimeInstanceId to null when the workspace has no binding", async () => {
    const d = deps();
    await make(d).provisioner.acquireInstanceForRun(input());
    const ctx = d.runtime.start.mock.calls[0][0];
    expect(d.registry.findBindingWithResource).toHaveBeenCalledWith("ws-1");
    expect(ctx.expectedRuntimeInstanceId).toBeNull();
  });

  it("sets ctx.expectedRuntimeInstanceId to the bound instance id when runtimeType matches", async () => {
    const d = deps();
    d.registry.findBindingWithResource.mockResolvedValueOnce({
      worker: { runtimeType: "local", instanceId: "bound-1" },
    });
    await make(d).provisioner.acquireInstanceForRun(input());
    const ctx = d.runtime.start.mock.calls[0][0];
    expect(ctx.expectedRuntimeInstanceId).toBe("bound-1");
  });

  it("treats a binding for a different runtimeType as no binding (expectedRuntimeInstanceId=null)", async () => {
    const d = deps();
    d.registry.findBindingWithResource.mockResolvedValueOnce({
      worker: { runtimeType: "docker", instanceId: "bound-1" },
    });
    await make(d).provisioner.acquireInstanceForRun(input());
    const ctx = d.runtime.start.mock.calls[0][0];
    expect(ctx.expectedRuntimeInstanceId).toBeNull();
  });

  it("threads an onExit hook (2nd start arg) that clears the owner map and marks the registry row stopped", async () => {
    const d = deps();
    const { provisioner: p } = make(d);
    await p.acquireInstanceForRun(input());
    const onExit = d.runtime.start.mock.calls[0][1];
    expect(typeof onExit).toBe("function");

    onExit();
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
    const { provisioner: p } = make(d);
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
    const res = await make(d).provisioner.acquireInstanceForRun(input());
    expect(res.outcome).toBe("error");
    expect(d.registry.markErrorByOwner).toHaveBeenCalledOnce();
  });

  it("reuses an existing running row on insertStarting conflict", async () => {
    const d = deps();
    d.registry.insertStarting.mockResolvedValueOnce({
      ok: false,
      existing: { runtimeInstanceId: "old", status: "running" },
    });
    const res = await make(d).provisioner.acquireInstanceForRun(input());
    expect(res).toEqual({ outcome: "ready", runtimeInstanceId: "old" });
    expect(d.runtime.start).not.toHaveBeenCalled();
  });

  it("clears the owner entry when insertStarting throws, so a retry can start fresh", async () => {
    const d = deps();
    d.registry.insertStarting.mockRejectedValueOnce(new Error("db down"));
    const { provisioner: p } = make(d);

    const res = await p.acquireInstanceForRun(input());
    expect(res.outcome).toBe("error");

    const res2 = await p.acquireInstanceForRun(input("r2"));
    expect(res2).toEqual({ outcome: "ready", runtimeInstanceId: "c1" });
    expect(d.registry.insertStarting).toHaveBeenCalledTimes(2);
    expect(d.runtime.start).toHaveBeenCalledOnce();
  });
});
