import { describe, it, expect, vi, beforeEach } from "vitest";
import { RuntimeService } from "./runtime.service";
import { ConfigService } from "../config/config.service";
import type {
  RuntimeProvider,
  RuntimeType,
  RuntimeLaunchContext,
  RuntimeInstanceRef,
} from "@agework/runtime";

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
    const providers = new Map<RuntimeType, RuntimeProvider>([
      ["local", fakeLocal],
      ["docker", fakeDocker],
      ["opensandbox", fakeOpenSandbox],
    ]);
    service = new RuntimeService(configService as ConfigService, providers);
  });

  it("resolveRuntimeSpec delegates to the pure resolver", () => {
    const result = service.resolveRuntimeSpec({
      userId: "u-1",
      workspaceId: "ws-1",
      workspaceRootPath: "/data/u-1/ws-1",
      userWorkspaceRootPath: "/data/u-1",
      runtimeLogHostPath: "/data/logs/runtime",
      runtimeType: "local",
    });
    expect(result.runtimeType).toBe("local");
    expect(result.ownerId).toBe("ws-1");
  });

  it("getRuntimePolicy reads from ConfigService", () => {
    expect(service.getRuntimePolicy()).toEqual({
      runtimeType: "local",
      allowedRuntimeTypes: ["local", "docker", "opensandbox"],
      isolationScope: "user",
      allowedIsolationScopes: ["user", "workspace"],
      idleTimeoutSeconds: 600,
    });
  });

  describe("dispatch by runtimeType", () => {
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
      await expect(service.start(ctx("docker"))).resolves.toEqual({
        runtimeInstanceId: "docker-instance",
      });
      expect(fakeDocker.start).toHaveBeenCalledOnce();
      expect(fakeLocal.start).not.toHaveBeenCalled();
      expect(fakeOpenSandbox.start).not.toHaveBeenCalled();
    });

    it("stop dispatches to the provider matching runtimeType", async () => {
      await service.stop(ref("docker"));
      expect(fakeDocker.stop).toHaveBeenCalledOnce();
      expect(fakeLocal.stop).not.toHaveBeenCalled();
    });

    it("destroy dispatches to the provider matching runtimeType", async () => {
      await service.destroy(ref("opensandbox"));
      expect(fakeOpenSandbox.destroy).toHaveBeenCalledOnce();
      expect(fakeDocker.destroy).not.toHaveBeenCalled();
    });

    it("throws for an unknown runtimeType", () => {
      expect(() => service.start(ctx("unknown" as RuntimeType))).toThrow(
        /Unknown runtime provider/
      );
      expect(() => service.stop(ref("unknown" as RuntimeType))).toThrow(
        /Unknown runtime provider/
      );
      expect(() => service.destroy(ref("unknown" as RuntimeType))).toThrow(
        /Unknown runtime provider/
      );
    });

    it("the legacy 'sandbox' runtimeType is dead: routing throws, never silently hits docker/opensandbox", () => {
      expect(() => service.start(ctx("sandbox" as RuntimeType))).toThrow(
        /Unknown runtime provider/
      );
      expect(fakeDocker.start).not.toHaveBeenCalled();
      expect(fakeOpenSandbox.start).not.toHaveBeenCalled();
    });
  });
});
