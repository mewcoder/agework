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
    prepareEnvironment: vi
      .fn()
      .mockResolvedValue({ runtimeInstanceId: `${type}-env` }),
    launchWorker: vi
      .fn()
      .mockResolvedValue({ runtimeInstanceId: `${type}-instance` }),
    teardown: vi.fn().mockResolvedValue(undefined),
    recoverOrphan: vi.fn().mockResolvedValue(undefined),
  };
}

describe("RuntimeService", () => {
  let configService: Partial<ConfigService>;
  let fakeLocal: ReturnType<typeof makeFakeProvider>;
  let fakeDocker: ReturnType<typeof makeFakeProvider>;
  let fakeOpenSandbox: ReturnType<typeof makeFakeProvider>;
  let service: RuntimeService;

  beforeEach(() => {
    configService = {
      getDefaultRuntimeType: vi.fn().mockReturnValue("local"),
      getDefaultIsolationScope: vi.fn().mockReturnValue("user"),
      getAllowedRuntimeTypes: vi
        .fn()
        .mockReturnValue(["local", "docker", "opensandbox"]),
      getAllowedIsolationScopes: vi.fn().mockReturnValue(["user", "workspace"]),
      getIdleTimeoutSeconds: vi.fn().mockReturnValue(600),
    };
    fakeLocal = makeFakeProvider("local");
    fakeDocker = makeFakeProvider("docker");
    fakeOpenSandbox = makeFakeProvider("opensandbox");
    service = new RuntimeService(configService as ConfigService, [
      fakeLocal,
      fakeDocker,
      fakeOpenSandbox,
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
      .mockReturnValue(["local", "docker", "opensandbox"]);
    configService.getAllowedIsolationScopes = vi
      .fn()
      .mockReturnValue(["user", "workspace"]);
    const policy = service.getRuntimePolicy();
    expect(policy).toEqual({
      runtimeType: "local",
      allowedRuntimeTypes: ["local", "docker", "opensandbox"],
      isolationScope: "user",
      allowedIsolationScopes: ["user", "workspace"],
      idleTimeoutSeconds: 600,
    });
  });

  describe("dispatch by runtimeType", () => {
    const ctx = (runtimeType: string): RuntimeLaunchContext => ({
      runtimeType,
      ownerId: "owner-1",
      workspaceId: "ws-1",
      runId: "run-1",
      placement: {} as never,
      workerEnv: {},
    });

    const ref = (runtimeType: string): RuntimeInstanceRef => ({
      runtimeType,
      ownerId: "owner-1",
      runtimeInstanceId: "instance-1",
      isolationScope: "user",
    });

    it("prepareEnvironment dispatches to the docker provider for runtimeType 'docker'", async () => {
      const input = ctx("docker");
      await expect(service.prepareEnvironment(input)).resolves.toEqual({
        runtimeInstanceId: "docker-env",
      });
      expect(fakeDocker.prepareEnvironment).toHaveBeenCalledWith(input);
      expect(fakeLocal.prepareEnvironment).not.toHaveBeenCalled();
      expect(fakeOpenSandbox.prepareEnvironment).not.toHaveBeenCalled();
    });

    it("prepareEnvironment dispatches to the opensandbox provider for runtimeType 'opensandbox'", async () => {
      const input = ctx("opensandbox");
      await expect(service.prepareEnvironment(input)).resolves.toEqual({
        runtimeInstanceId: "opensandbox-env",
      });
      expect(fakeOpenSandbox.prepareEnvironment).toHaveBeenCalledWith(input);
      expect(fakeLocal.prepareEnvironment).not.toHaveBeenCalled();
      expect(fakeDocker.prepareEnvironment).not.toHaveBeenCalled();
    });

    it("launchWorker dispatches to the provider matching runtimeType", async () => {
      const input = ctx("local");
      const env: RuntimeEnvHandle = {};
      await expect(service.launchWorker(input, env)).resolves.toEqual({
        runtimeInstanceId: "local-instance",
      });
      expect(fakeLocal.launchWorker).toHaveBeenCalledWith(input, env);
      expect(fakeDocker.launchWorker).not.toHaveBeenCalled();
      expect(fakeOpenSandbox.launchWorker).not.toHaveBeenCalled();
    });

    it("teardown dispatches to the docker provider for runtimeType 'docker'", async () => {
      const input = ref("docker");
      await service.teardown(input);
      expect(fakeDocker.teardown).toHaveBeenCalledWith(input);
      expect(fakeLocal.teardown).not.toHaveBeenCalled();
      expect(fakeOpenSandbox.teardown).not.toHaveBeenCalled();
    });

    it("teardown dispatches to the opensandbox provider for runtimeType 'opensandbox'", async () => {
      const input = ref("opensandbox");
      await service.teardown(input);
      expect(fakeOpenSandbox.teardown).toHaveBeenCalledWith(input);
      expect(fakeLocal.teardown).not.toHaveBeenCalled();
      expect(fakeDocker.teardown).not.toHaveBeenCalled();
    });

    it("recoverOrphan dispatches to the provider matching runtimeType", async () => {
      const input = ref("local");
      await service.recoverOrphan(input);
      expect(fakeLocal.recoverOrphan).toHaveBeenCalledWith(input);
      expect(fakeDocker.recoverOrphan).not.toHaveBeenCalled();
      expect(fakeOpenSandbox.recoverOrphan).not.toHaveBeenCalled();
    });

    it("throws for an unknown runtimeType", () => {
      expect(() => service.prepareEnvironment(ctx("unknown"))).toThrow(
        /Unknown runtime provider/
      );
      expect(() => service.teardown(ref("unknown"))).toThrow(
        /Unknown runtime provider/
      );
    });

    it("the legacy 'sandbox' runtimeType is dead: no provider registers under it, so routing throws", () => {
      // Regression guard: mid-refactor, providers were briefly registered under
      // type:"sandbox" before the domain value fully migrated to docker/opensandbox.
      // This proves that intermediate state did not survive to the final tree —
      // "sandbox" resolves to nothing, it does NOT silently hit docker or opensandbox.
      expect(() => service.prepareEnvironment(ctx("sandbox"))).toThrow(
        /Unknown runtime provider/
      );
      expect(() => service.teardown(ref("sandbox"))).toThrow(
        /Unknown runtime provider/
      );
      expect(fakeDocker.prepareEnvironment).not.toHaveBeenCalled();
      expect(fakeOpenSandbox.prepareEnvironment).not.toHaveBeenCalled();
      expect(fakeDocker.teardown).not.toHaveBeenCalled();
      expect(fakeOpenSandbox.teardown).not.toHaveBeenCalled();
    });
  });
});
