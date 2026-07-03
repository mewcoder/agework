import { describe, it, expect, vi } from "vitest";
import { SandboxRuntimeProvider } from "./sandbox-runtime.provider";
import type { SandboxEngine } from "./sandbox-engine";
import type { RuntimeLaunchContext } from "../runtime.types";

const engine = (type: "docker" | "opensandbox"): SandboxEngine => ({
  type,
  getOrCreate: vi.fn().mockResolvedValue({ engineType: type, runtimeInstanceId: "c1", workspaceMountPath: "/w" }),
  startWorker: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue(undefined),
});

const ctx = (): RuntimeLaunchContext => ({
  runtimeType: "sandbox",
  ownerId: "ws-1",
  workspaceId: "ws-1",
  runId: "run-1",
  placement: {
    runtimeType: "sandbox",
    userId: "u1",
    workspaceId: "ws-1",
    hostPath: "/host",
    runtimePath: "/rt",
    runtimeLogDir: "/logs",
    sandbox: { isolationScope: "workspace", mountTarget: "/rt", sandboxEngineType: "docker" },
  },
  workerEnv: { AGEWORK_WORKER_OWNER_ID: "ws-1" },
});

const cfg = { getRuntimeLogDir: () => "/host/logs" } as any;

describe("SandboxRuntimeProvider", () => {
  it("declares container placement", () => {
    const p = new SandboxRuntimeProvider(cfg, [engine("docker")]);
    expect(p.type).toBe("sandbox");
    expect(p.placementKind).toBe("container");
  });

  it("prepareEnvironment creates container + starts worker via engine", async () => {
    const docker = engine("docker");
    const p = new SandboxRuntimeProvider(cfg, [docker]);
    const handle = await p.prepareEnvironment(ctx());
    expect(docker.getOrCreate).toHaveBeenCalledOnce();
    expect(docker.startWorker).toHaveBeenCalledOnce();
    expect(handle.runtimeInstanceId).toBe("c1");
  });

  it("launchWorker echoes the prepared instance id", async () => {
    const p = new SandboxRuntimeProvider(cfg, [engine("docker")]);
    const res = await p.launchWorker(ctx(), { runtimeInstanceId: "c1" });
    expect(res.runtimeInstanceId).toBe("c1");
  });

  it("teardown stops via the engine", async () => {
    const docker = engine("docker");
    const p = new SandboxRuntimeProvider(cfg, [docker]);
    await p.teardown({ runtimeType: "sandbox", ownerId: "ws-1", runtimeInstanceId: "c1", isolationScope: "workspace" });
    expect(docker.stop).toHaveBeenCalledWith("c1");
  });
});
