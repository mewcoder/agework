import { describe, it, expect, vi, beforeEach } from "vitest";
import { RuntimeService } from "./runtime.service";
import { ConfigService } from "../config/config.service";
import type {
  RuntimeProvider,
  RuntimeLaunchContext,
  RuntimeInstanceRef,
} from "./runtime.types";

function makeFakeProvider(type: string): RuntimeProvider & {
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

    it("start dispatches to the docker provider for runtimeType 'docker'", async () => {
      const input = ctx("docker");
      await expect(service.start(input)).resolves.toEqual({
        runtimeInstanceId: "docker-instance",
      });
      expect(fakeDocker.start).toHaveBeenCalledWith(input);
      expect(fakeLocal.start).not.toHaveBeenCalled();
      expect(fakeOpenSandbox.start).not.toHaveBeenCalled();
    });

    it("start dispatches to the opensandbox provider for runtimeType 'opensandbox'", async () => {
      const input = ctx("opensandbox");
      await expect(service.start(input)).resolves.toEqual({
        runtimeInstanceId: "opensandbox-instance",
      });
      expect(fakeOpenSandbox.start).toHaveBeenCalledWith(input);
      expect(fakeLocal.start).not.toHaveBeenCalled();
      expect(fakeDocker.start).not.toHaveBeenCalled();
    });

    it("stop dispatches to the provider matching runtimeType", async () => {
      const input = ref("docker");
      await service.stop(input);
      expect(fakeDocker.stop).toHaveBeenCalledWith(input);
      expect(fakeLocal.stop).not.toHaveBeenCalled();
      expect(fakeOpenSandbox.stop).not.toHaveBeenCalled();
    });

    it("destroy dispatches to the provider matching runtimeType", async () => {
      const input = ref("opensandbox");
      await service.destroy(input);
      expect(fakeOpenSandbox.destroy).toHaveBeenCalledWith(input);
      expect(fakeLocal.destroy).not.toHaveBeenCalled();
      expect(fakeDocker.destroy).not.toHaveBeenCalled();
    });

    it("throws for an unknown runtimeType", () => {
      expect(() => service.start(ctx("unknown"))).toThrow(
        /Unknown runtime provider/
      );
      expect(() => service.stop(ref("unknown"))).toThrow(
        /Unknown runtime provider/
      );
      expect(() => service.destroy(ref("unknown"))).toThrow(
        /Unknown runtime provider/
      );
    });

    it("the legacy 'sandbox' runtimeType is dead: routing throws, never silently hits docker/opensandbox", () => {
      expect(() => service.start(ctx("sandbox"))).toThrow(
        /Unknown runtime provider/
      );
      expect(() => service.stop(ref("sandbox"))).toThrow(
        /Unknown runtime provider/
      );
      expect(fakeDocker.start).not.toHaveBeenCalled();
      expect(fakeOpenSandbox.start).not.toHaveBeenCalled();
      expect(fakeDocker.stop).not.toHaveBeenCalled();
      expect(fakeOpenSandbox.stop).not.toHaveBeenCalled();
    });
  });
});
