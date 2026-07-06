import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RuntimeProvider, RuntimeType } from "@agework/providers";
import type {
  RuntimeInstanceRefRpcParams,
  RuntimeLaunchRpcParams,
} from "@agework/shared/protocol";
import type { RegisteredRuntimeConfig } from "../config.js";
import { Launcher } from "./launcher.js";
import { LiveCarrierStore } from "./registry.js";

const { fakes } = vi.hoisted(() => ({
  fakes: new Map<string, RuntimeProvider>(),
}));

vi.mock("@agework/providers", async (importActual) => {
  const actual = await importActual<typeof import("@agework/providers")>();
  return {
    ...actual,
    createRuntimeResolver: () => (type: string) => {
      const provider = fakes.get(type);
      if (!provider) throw new Error(`Unknown runtime provider: ${type}`);
      return provider;
    },
  };
});

function makeFakeProvider(type: RuntimeType): RuntimeProvider & {
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
} {
  return {
    type,
    start: vi.fn().mockResolvedValue({ runtimeInstanceId: "container-1" }),
    stop: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
  };
}

const dockerConfig: RegisteredRuntimeConfig = {
  serverBaseUrl: "http://server/api/v1",
  token: "t",
  runtimeType: "docker",
  runtimeLogHostPath: "/logs",
  workerImage: "agework/runtime:latest",
};

const launchParams: RuntimeLaunchRpcParams = {
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
  expectedRuntimeInstanceId: null,
};

describe("Launcher", () => {
  let fakeDocker: ReturnType<typeof makeFakeProvider>;
  let fakeLocal: ReturnType<typeof makeFakeProvider>;
  let registry: LiveCarrierStore;

  beforeEach(() => {
    fakeDocker = makeFakeProvider("docker");
    fakeLocal = makeFakeProvider("local");
    fakes.clear();
    fakes.set("docker", fakeDocker);
    fakes.set("local", fakeLocal);
    registry = new LiveCarrierStore();
  });

  it("launch dispatches to the provider matching the configured runtimeType", async () => {
    const launcher = new Launcher(dockerConfig, registry);

    const result = await launcher.launch(launchParams);

    expect(result).toEqual({ runtimeInstanceId: "container-1" });
    expect(fakeDocker.start).toHaveBeenCalledOnce();
    expect(fakeLocal.start).not.toHaveBeenCalled();
    const [ctx] = fakeDocker.start.mock.calls[0];
    expect(ctx.runtimeType).toBe("docker");
    expect(ctx.ownerId).toBe("owner-1");
    expect(ctx.expectedRuntimeInstanceId).toBeNull();
  });

  it("launch records the started instance in the registry", async () => {
    const launcher = new Launcher(dockerConfig, registry);

    await launcher.launch(launchParams);

    expect(registry.get("owner-1")).toEqual({
      runtimeInstanceId: "container-1",
      isolationScope: "workspace",
    });
  });

  it("launch's onExit hook removes the registry entry when the carrier exits", async () => {
    const launcher = new Launcher(dockerConfig, registry);
    await launcher.launch(launchParams);
    expect(registry.get("owner-1")).toBeDefined();

    const onExit = fakeDocker.start.mock.calls[0][1] as () => void;
    onExit();

    expect(registry.get("owner-1")).toBeUndefined();
  });

  it("stop dispatches to the provider and clears the registry entry", async () => {
    const launcher = new Launcher(dockerConfig, registry);
    registry.record("owner-1", {
      runtimeInstanceId: "container-1",
      isolationScope: "workspace",
    });
    const params: RuntimeInstanceRefRpcParams = {
      ownerId: "owner-1",
      runtimeInstanceId: "container-1",
      isolationScope: "workspace",
    };

    await launcher.stop(params);

    expect(fakeDocker.stop).toHaveBeenCalledWith({
      runtimeType: "docker",
      ownerId: "owner-1",
      runtimeInstanceId: "container-1",
      isolationScope: "workspace",
    });
    expect(registry.get("owner-1")).toBeUndefined();
  });

  it("destroy dispatches to the provider and clears the registry entry", async () => {
    const launcher = new Launcher(dockerConfig, registry);
    const params: RuntimeInstanceRefRpcParams = {
      ownerId: "owner-1",
      runtimeInstanceId: "container-1",
      isolationScope: "workspace",
    };

    await launcher.destroy(params);

    expect(fakeDocker.destroy).toHaveBeenCalledWith({
      runtimeType: "docker",
      ownerId: "owner-1",
      runtimeInstanceId: "container-1",
      isolationScope: "workspace",
    });
  });

  it("records isolationScope='workspace' for local placements (no sandbox object)", async () => {
    const localConfig: RegisteredRuntimeConfig = {
      ...dockerConfig,
      runtimeType: "local",
      workerImage: undefined,
      runtimeEntryPath: "/app/dist/main.js",
    };
    const launcher = new Launcher(localConfig, registry);
    const localParams: RuntimeLaunchRpcParams = {
      ...launchParams,
      placement: {
        runtimeType: "local",
        userId: "u1",
        workspaceId: "ws-1",
        hostPath: "/w",
        runtimePath: "/w",
        runtimeLogDir: "/logs",
        ownerId: "owner-1",
      } as never,
    };

    await launcher.launch(localParams);

    expect(fakeLocal.start).toHaveBeenCalledOnce();
    expect(registry.get("owner-1")?.isolationScope).toBe("workspace");
  });
});
