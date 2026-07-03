import { describe, it, expect, vi } from "vitest";
import { ContainerRuntimeProvider } from "./container-runtime.provider";
import type { SandboxEngine } from "./sandbox-engine";
import type { RuntimeLaunchContext } from "../runtime.types";

class TestContainerProvider extends ContainerRuntimeProvider {
  readonly type = "docker";
}

const engine = (): SandboxEngine => ({
  type: "docker",
  getOrCreate: vi.fn().mockResolvedValue({
    engineType: "docker",
    runtimeInstanceId: "c1",
    workspaceMountPath: "/w",
  }),
  startWorker: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue(undefined),
});

const cfg = { getRuntimeLogDir: () => "/host/logs" } as any;
const ctx = (): RuntimeLaunchContext => ({
  runtimeType: "docker",
  ownerId: "ws-1",
  workspaceId: "ws-1",
  runId: "run-1",
  placement: {
    runtimeType: "docker",
    userId: "u1",
    workspaceId: "ws-1",
    hostPath: "/host",
    runtimePath: "/rt",
    runtimeLogDir: "/logs",
    sandbox: {
      isolationScope: "workspace",
      mountTarget: "/rt",
      sandboxEngineType: "docker",
    },
  },
  workerEnv: { AGEWORK_WORKER_OWNER_ID: "ws-1" },
  isExpectedRuntimeInstance: async () => true,
});

describe("ContainerRuntimeProvider", () => {
  it("declares container placement and its engine's type", () => {
    const p = new TestContainerProvider(cfg, engine());
    expect(p.placementKind).toBe("container");
    expect(p.type).toBe("docker");
  });
  it("prepareEnvironment creates + starts worker via its engine and threads isExpectedRuntimeInstance", async () => {
    const e = engine();
    const p = new TestContainerProvider(cfg, e);
    const handle = await p.prepareEnvironment(ctx());
    expect(e.getOrCreate).toHaveBeenCalledOnce();
    const passedInput = (e.getOrCreate as any).mock.calls[0][0];
    expect(typeof passedInput.isExpectedRuntimeInstance).toBe("function");
    expect(passedInput.env.AGEWORK_WORKER_SANDBOX_ENGINE).toBe("docker");
    expect(handle.runtimeInstanceId).toBe("c1");
  });
  it("teardown stops via its engine", async () => {
    const e = engine();
    const p = new TestContainerProvider(cfg, e);
    await p.teardown({
      runtimeType: "docker",
      ownerId: "ws-1",
      runtimeInstanceId: "c1",
      isolationScope: "workspace",
    });
    expect(e.stop).toHaveBeenCalledWith("c1");
  });
});
