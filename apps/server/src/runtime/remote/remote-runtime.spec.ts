import { describe, it, expect, vi } from "vitest";
import type {
  RuntimeLaunchContext,
  RuntimeInstanceRef,
} from "@agework/providers";
import { RemoteRuntime } from "./remote-runtime";
import type { RuntimeTunnelHandler } from "../gateway/runtime-tunnel.handler";

function makeTunnel() {
  return {
    sendRequest: vi
      .fn()
      .mockResolvedValue({ runtimeInstanceId: "container-1" }),
  };
}

const ctx: RuntimeLaunchContext = {
  runtimeType: "docker",
  ownerId: "owner-1",
  workspaceId: "ws-1",
  runId: "run-1",
  placement: {
    runtimeType: "docker",
    userId: "u1",
    workspaceId: "ws-1",
    hostPath: "/w",
    runtimePath: "/w",
    runtimeLogDir: "/logs",
    sandbox: { isolationScope: "workspace", mountTarget: "/workspace" },
    ownerId: "owner-1",
  } as never,
  workerEnv: { AGEWORK_WORKER_ROLE: "worker" },
  expectedRuntimeInstanceId: "prior-1",
};

const ref: RuntimeInstanceRef = {
  runtimeType: "docker",
  ownerId: "owner-1",
  runtimeInstanceId: "container-1",
  isolationScope: "workspace",
};

describe("RemoteRuntime", () => {
  it("start sends a runtime.launch RPC with a serializable params subset and returns the result", async () => {
    const tunnel = makeTunnel();
    const runtime = new RemoteRuntime(
      "rt-1",
      tunnel as unknown as RuntimeTunnelHandler,
      15_000
    );

    const result = await runtime.start(ctx);

    expect(result).toEqual({ runtimeInstanceId: "container-1" });
    expect(tunnel.sendRequest).toHaveBeenCalledWith(
      "rt-1",
      expect.objectContaining({
        jsonrpc: "2.0",
        method: "runtime.launch",
        params: {
          ownerId: "owner-1",
          workspaceId: "ws-1",
          runId: "run-1",
          placement: ctx.placement,
          workerEnv: ctx.workerEnv,
          expectedRuntimeInstanceId: "prior-1",
        },
      }),
      15_000
    );
    // runtimeType is not sent — manager already knows its own fixed type
    const params = tunnel.sendRequest.mock.calls[0][1].params;
    expect(params).not.toHaveProperty("runtimeType");
  });

  it("start defaults expectedRuntimeInstanceId to null when omitted", async () => {
    const tunnel = makeTunnel();
    const runtime = new RemoteRuntime(
      "rt-1",
      tunnel as unknown as RuntimeTunnelHandler,
      15_000
    );

    await runtime.start({ ...ctx, expectedRuntimeInstanceId: undefined });

    expect(tunnel.sendRequest.mock.calls[0][1].params).toMatchObject({
      expectedRuntimeInstanceId: null,
    });
  });

  it("stop sends a runtime.stop RPC with a fixed teardown timeout, ignoring runtimeType", async () => {
    const tunnel = makeTunnel();
    const runtime = new RemoteRuntime(
      "rt-1",
      tunnel as unknown as RuntimeTunnelHandler,
      15_000
    );

    await runtime.stop(ref);

    expect(tunnel.sendRequest).toHaveBeenCalledWith(
      "rt-1",
      expect.objectContaining({
        method: "runtime.stop",
        params: {
          ownerId: "owner-1",
          runtimeInstanceId: "container-1",
          isolationScope: "workspace",
        },
      }),
      30_000
    );
  });

  it("destroy sends a runtime.destroy RPC", async () => {
    const tunnel = makeTunnel();
    const runtime = new RemoteRuntime(
      "rt-1",
      tunnel as unknown as RuntimeTunnelHandler,
      15_000
    );

    await runtime.destroy(ref);

    expect(tunnel.sendRequest).toHaveBeenCalledWith(
      "rt-1",
      expect.objectContaining({ method: "runtime.destroy" }),
      30_000
    );
  });

  it("propagates a rejection from the tunnel (e.g. runtime offline or timeout)", async () => {
    const tunnel = makeTunnel();
    tunnel.sendRequest.mockRejectedValueOnce(
      new Error("runtime rt-1 is not connected")
    );
    const runtime = new RemoteRuntime(
      "rt-1",
      tunnel as unknown as RuntimeTunnelHandler,
      15_000
    );

    await expect(runtime.start(ctx)).rejects.toThrow("is not connected");
  });
});
