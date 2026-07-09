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
  let fakeNative: ReturnType<typeof makeFakeProvider>;
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
    fakeNative = makeFakeProvider("native");
    fakes.clear();
    fakes.set("native", fakeNative);
    fakes.set("docker", makeFakeProvider("docker"));
    fakes.set("opensandbox", makeFakeProvider("opensandbox"));
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
    workerId: "worker-1",
    runtimeInstanceId: "instance-1",
    isolationScope: "user",
  });

  it("start always dispatches to the native provider, regardless of ctx.runtimeType", async () => {
    await expect(runtime.start(ctx("native"))).resolves.toEqual({
      runtimeInstanceId: "native-instance",
    });
    expect(fakeNative.start).toHaveBeenCalledOnce();
  });

  it("forwards the onExit hook through to the native provider", async () => {
    const onExit = vi.fn();
    await runtime.start(ctx("native"), onExit);
    expect(fakeNative.start).toHaveBeenCalledWith(ctx("native"), onExit);
  });

  it("stop always dispatches to the native provider", async () => {
    await runtime.stop(ref("native"));
    expect(fakeNative.stop).toHaveBeenCalledOnce();
  });

  it("destroy always dispatches to the native provider", async () => {
    await runtime.destroy(ref("native"));
    expect(fakeNative.destroy).toHaveBeenCalledOnce();
  });
});
