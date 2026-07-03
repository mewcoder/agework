import { describe, it, expect, vi, beforeEach } from "vitest";
import { RuntimeService } from "./runtime.service";
import { ConfigService } from "../config/config.service";
import type {
  RuntimeProvider,
  RuntimeLaunchContext,
  RuntimeEnvHandle,
  RuntimeInstanceRef,
} from "./runtime.types";

function makeFakeProvider(type: string): RuntimeProvider & {
  prepareEnvironment: ReturnType<typeof vi.fn>;
  launchWorker: ReturnType<typeof vi.fn>;
  teardown: ReturnType<typeof vi.fn>;
  recoverOrphan: ReturnType<typeof vi.fn>;
} {
  return {
    type,
    placementKind: "process",
    prepareEnvironment: vi.fn().mockResolvedValue({ runtimeInstanceId: `${type}-env` }),
    launchWorker: vi.fn().mockResolvedValue({ runtimeInstanceId: `${type}-instance` }),
    teardown: vi.fn().mockResolvedValue(undefined),
    recoverOrphan: vi.fn().mockResolvedValue(undefined),
  };
}

describe("RuntimeService", () => {
  let configService: Partial<ConfigService>;
  let fakeLocal: ReturnType<typeof makeFakeProvider>;
  let fakeSandbox: ReturnType<typeof makeFakeProvider>;
  let service: RuntimeService;

  beforeEach(() => {
    configService = {
      getDefaultRuntimeType: vi.fn().mockReturnValue("local"),
      getDefaultIsolationScope: vi.fn().mockReturnValue("user"),
      getSandboxEngine: vi.fn().mockReturnValue("docker"),
      getAllowedRuntimeTypes: vi.fn().mockReturnValue(["local", "sandbox"]),
      getAllowedIsolationScopes: vi.fn().mockReturnValue(["user", "workspace"]),
      getIdleTimeoutSeconds: vi.fn().mockReturnValue(600),
    };
    fakeLocal = makeFakeProvider("local");
    fakeSandbox = makeFakeProvider("sandbox");
    service = new RuntimeService(configService as ConfigService, [
      fakeLocal,
      fakeSandbox,
    ]);
  });

  it("resolveRuntimeTarget delegates to the pure resolver", () => {
    const input = {
      userId: "u-1",
      workspaceId: "ws-1",
      workspaceRootPath: "/data/u-1/ws-1",
      userWorkspaceRootPath: "/data/u-1",
      runtimeLogHostPath: "/data/logs/runtime",
      runtimeType: "local" as const,
    };
    const result = service.resolveRuntimeTarget(input);
    expect(result.runtimeType).toBe("local");
    expect(result.ownerId).toBe("ws-1");
  });

  it("getRuntimePolicy reads from ConfigService", () => {
    configService.getAllowedRuntimeTypes = vi
      .fn()
      .mockReturnValue(["local", "sandbox"]);
    configService.getAllowedIsolationScopes = vi
      .fn()
      .mockReturnValue(["user", "workspace"]);
    const policy = service.getRuntimePolicy();
    expect(policy).toEqual({
      runtimeType: "local",
      allowedRuntimeTypes: ["local", "sandbox"],
      isolationScope: "user",
      allowedIsolationScopes: ["user", "workspace"],
      idleTimeoutSeconds: 600,
    });
  });

  describe("dispatch by runtimeType", () => {
    const ctx = (runtimeType: string): RuntimeLaunchContext =>
      ({
        runtimeType,
        ownerId: "owner-1",
        workspaceId: "ws-1",
        runId: "run-1",
        placement: {} as never,
        workerEnv: {},
      }) as RuntimeLaunchContext;

    const ref = (runtimeType: string): RuntimeInstanceRef => ({
      runtimeType,
      ownerId: "owner-1",
      runtimeInstanceId: "instance-1",
      isolationScope: "user",
    });

    it("prepareEnvironment dispatches to the provider matching runtimeType", async () => {
      const input = ctx("sandbox");
      await expect(service.prepareEnvironment(input)).resolves.toEqual({
        runtimeInstanceId: "sandbox-env",
      });
      expect(fakeSandbox.prepareEnvironment).toHaveBeenCalledWith(input);
      expect(fakeLocal.prepareEnvironment).not.toHaveBeenCalled();
    });

    it("launchWorker dispatches to the provider matching runtimeType", async () => {
      const input = ctx("local");
      const env: RuntimeEnvHandle = {};
      await expect(service.launchWorker(input, env)).resolves.toEqual({
        runtimeInstanceId: "local-instance",
      });
      expect(fakeLocal.launchWorker).toHaveBeenCalledWith(input, env);
      expect(fakeSandbox.launchWorker).not.toHaveBeenCalled();
    });

    it("teardown dispatches to the provider matching runtimeType", async () => {
      const input = ref("sandbox");
      await service.teardown(input);
      expect(fakeSandbox.teardown).toHaveBeenCalledWith(input);
      expect(fakeLocal.teardown).not.toHaveBeenCalled();
    });

    it("recoverOrphan dispatches to the provider matching runtimeType", async () => {
      const input = ref("local");
      await service.recoverOrphan(input);
      expect(fakeLocal.recoverOrphan).toHaveBeenCalledWith(input);
      expect(fakeSandbox.recoverOrphan).not.toHaveBeenCalled();
    });

    it("throws for an unknown runtimeType", () => {
      expect(() => service.prepareEnvironment(ctx("unknown"))).toThrow(
        /Unknown runtime provider/
      );
      expect(() => service.teardown(ref("unknown"))).toThrow(
        /Unknown runtime provider/
      );
    });
  });
});
