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
  workerId: "worker-1",
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
          workerId: "worker-1",
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

  // ── 文件预览 / git diff 隧道 RPC ───────────────────────────────

  it("listFiles sends a runtime.list-files RPC with rootPath and path", async () => {
    const tunnel = makeTunnel();
    tunnel.sendRequest.mockResolvedValueOnce({
      path: "src",
      list: [{ name: "a.ts", type: "file", size: 10 }],
      truncated: false,
    });
    const runtime = new RemoteRuntime(
      "rt-1",
      tunnel as unknown as RuntimeTunnelHandler,
      15_000
    );

    const result = await runtime.listFiles("/remote/ws", "src");

    expect(tunnel.sendRequest).toHaveBeenCalledWith(
      "rt-1",
      expect.objectContaining({
        method: "runtime.list-files",
        params: { rootPath: "/remote/ws", path: "src" },
      }),
      15_000
    );
    expect(result.list[0].name).toBe("a.ts");
  });

  it("readFile sends a runtime.read-file RPC with rootPath and path", async () => {
    const tunnel = makeTunnel();
    tunnel.sendRequest.mockResolvedValueOnce({
      path: "a.ts",
      encoding: "utf8",
      content: "hello",
      size: 5,
      truncated: false,
    });
    const runtime = new RemoteRuntime(
      "rt-1",
      tunnel as unknown as RuntimeTunnelHandler,
      15_000
    );

    const result = await runtime.readFile("/remote/ws", "a.ts");

    expect(tunnel.sendRequest).toHaveBeenCalledWith(
      "rt-1",
      expect.objectContaining({
        method: "runtime.read-file",
        params: { rootPath: "/remote/ws", path: "a.ts" },
      }),
      15_000
    );
    expect(result.content).toBe("hello");
  });

  it("listChangedFiles sends a runtime.list-changed-files RPC with rootPath", async () => {
    const tunnel = makeTunnel();
    tunnel.sendRequest.mockResolvedValueOnce({
      list: [{ path: "a.ts", status: "modified", additions: 1, deletions: 0 }],
      truncated: false,
    });
    const runtime = new RemoteRuntime(
      "rt-1",
      tunnel as unknown as RuntimeTunnelHandler,
      15_000
    );

    const result = await runtime.listChangedFiles("/remote/ws");

    expect(tunnel.sendRequest).toHaveBeenCalledWith(
      "rt-1",
      expect.objectContaining({
        method: "runtime.list-changed-files",
        params: { rootPath: "/remote/ws" },
      }),
      15_000
    );
    expect(result.list[0].path).toBe("a.ts");
  });

  it("readFileDiff sends a runtime.read-file-diff RPC with rootPath and path", async () => {
    const tunnel = makeTunnel();
    tunnel.sendRequest.mockResolvedValueOnce({
      path: "a.ts",
      status: "modified",
      before: "old",
      after: "new",
    });
    const runtime = new RemoteRuntime(
      "rt-1",
      tunnel as unknown as RuntimeTunnelHandler,
      15_000
    );

    const result = await runtime.readFileDiff("/remote/ws", "a.ts");

    expect(tunnel.sendRequest).toHaveBeenCalledWith(
      "rt-1",
      expect.objectContaining({
        method: "runtime.read-file-diff",
        params: { rootPath: "/remote/ws", path: "a.ts" },
      }),
      15_000
    );
    expect(result.after).toBe("new");
  });
});
