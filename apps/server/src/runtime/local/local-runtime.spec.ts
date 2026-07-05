import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  RuntimeProvider,
  RuntimeType,
  RuntimeLaunchContext,
  RuntimeInstanceRef,
} from "@agework/providers";
import { ConfigService } from "../../config/config.service";
import { LocalRuntime } from "./local-runtime";

// provider 装配收在 LocalRuntime 构造函数内(createRuntimeResolver),这里 mock
// 掉工厂、注入 fake resolver 以测分发。
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
    start: vi.fn().mockResolvedValue({ runtimeInstanceId: `${type}-instance` }),
    stop: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
  };
}

describe("LocalRuntime", () => {
  let configService: Partial<ConfigService>;
  let fakeLocal: ReturnType<typeof makeFakeProvider>;
  let fakeDocker: ReturnType<typeof makeFakeProvider>;
  let fakeOpenSandbox: ReturnType<typeof makeFakeProvider>;
  let runtime: LocalRuntime;

  beforeEach(() => {
    configService = {
      // 构造期 toRuntimeConfig 会读这两个
      getRuntimeLogDir: vi.fn().mockReturnValue("/tmp/agework-runtime-logs"),
      getOpenSandboxConfig: vi.fn().mockReturnValue({
        domain: "opensandbox.test",
        protocol: "https",
        apiKey: "test-key",
        useServerProxy: false,
      }),
    };
    fakeLocal = makeFakeProvider("local");
    fakeDocker = makeFakeProvider("docker");
    fakeOpenSandbox = makeFakeProvider("opensandbox");
    fakes.clear();
    fakes.set("local", fakeLocal);
    fakes.set("docker", fakeDocker);
    fakes.set("opensandbox", fakeOpenSandbox);
    runtime = new LocalRuntime(configService as ConfigService);
  });

  const ctx = (runtimeType: RuntimeType): RuntimeLaunchContext => ({
    runtimeType,
    ownerId: "owner-1",
    workspaceId: "ws-1",
    runId: "run-1",
    placement: {} as never,
    workerEnv: {},
  });

  const ref = (runtimeType: RuntimeType): RuntimeInstanceRef => ({
    runtimeType,
    ownerId: "owner-1",
    runtimeInstanceId: "instance-1",
    isolationScope: "user",
  });

  it("start dispatches to the docker provider", async () => {
    await expect(runtime.start(ctx("docker"))).resolves.toEqual({
      runtimeInstanceId: "docker-instance",
    });
    expect(fakeDocker.start).toHaveBeenCalledOnce();
    expect(fakeLocal.start).not.toHaveBeenCalled();
    expect(fakeOpenSandbox.start).not.toHaveBeenCalled();
  });

  it("forwards the onExit hook through to the provider", async () => {
    const onExit = vi.fn();
    await runtime.start(ctx("local"), onExit);
    expect(fakeLocal.start).toHaveBeenCalledWith(ctx("local"), onExit);
  });

  it("stop dispatches to the provider matching runtimeType", async () => {
    await runtime.stop(ref("docker"));
    expect(fakeDocker.stop).toHaveBeenCalledOnce();
    expect(fakeLocal.stop).not.toHaveBeenCalled();
  });

  it("destroy dispatches to the provider matching runtimeType", async () => {
    await runtime.destroy(ref("opensandbox"));
    expect(fakeOpenSandbox.destroy).toHaveBeenCalledOnce();
    expect(fakeDocker.destroy).not.toHaveBeenCalled();
  });
});
