import { describe, it, expect, vi, beforeEach } from "vitest";
import { RuntimeService } from "./runtime.service";
import { ConfigService } from "../config/config.service";
import type { SandboxEngine } from "./sandbox/sandbox-engine";
import type { LocalRuntimeProvider } from "./local/local-runtime.provider";

describe("RuntimeService", () => {
  let configService: Partial<ConfigService>;
  let engine: SandboxEngine;
  let localProvider: {
    launch: ReturnType<typeof vi.fn>;
    recoverOrphan: ReturnType<typeof vi.fn>;
  };
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
    engine = {
      type: "docker",
      getOrCreate: vi.fn().mockResolvedValue({
        engineType: "docker",
        runtimeInstanceId: "container-1",
        workspaceMountPath: "/workspace",
      }),
      startWorker: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      resume: vi.fn().mockResolvedValue({
        engineType: "docker",
        runtimeInstanceId: "container-1",
        workspaceMountPath: "/workspace",
      }),
    };
    localProvider = {
      launch: vi.fn().mockReturnValue({
        runtimeInstanceId: "12345:token",
        channel: {} as never,
      }),
      recoverOrphan: vi.fn().mockResolvedValue(undefined),
    };
    service = new RuntimeService(
      configService as ConfigService,
      [engine],
      localProvider as unknown as LocalRuntimeProvider
    );
  });

  it("resolveRuntimeTarget delegates to the pure resolver with config", () => {
    const input = {
      userId: "u-1",
      workspaceId: "ws-1",
      workspaceRootPath: "/data/u-1/ws-1",
      userWorkspaceRootPath: "/data/u-1",
    };
    const result = service.resolveRuntimeTarget(input);
    expect(result.runtimeType).toBe("local");
    expect(result.ownerId).toBe("ws-1");
    expect(configService.getDefaultRuntimeType).toHaveBeenCalled();
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

  describe("sandbox engine facade", () => {
    it("getOrCreateSandbox delegates to the resolved engine", async () => {
      const input = { placement: {} } as never;
      await expect(
        service.getOrCreateSandbox("docker", input)
      ).resolves.toEqual({
        engineType: "docker",
        runtimeInstanceId: "container-1",
        workspaceMountPath: "/workspace",
      });
      expect(engine.getOrCreate).toHaveBeenCalledWith(input);
    });

    it("resumeSandbox delegates to the resolved engine's resume method", async () => {
      const input = { placement: {} } as never;
      await expect(
        service.resumeSandbox("docker", "container-1", input)
      ).resolves.toEqual({
        engineType: "docker",
        runtimeInstanceId: "container-1",
        workspaceMountPath: "/workspace",
      });
      expect(engine.resume).toHaveBeenCalledWith("container-1", input);
    });

    it("resumeSandbox returns undefined when the engine has no resume support", () => {
      engine.resume = undefined;
      const result = service.resumeSandbox(
        "docker",
        "container-1",
        {} as never
      );
      expect(result).toBeUndefined();
    });

    it("startSandboxWorker delegates to the resolved engine", async () => {
      const runtime = {
        engineType: "docker",
        runtimeInstanceId: "container-1",
        workspaceMountPath: "/workspace",
      } as never;
      const input = {} as never;
      await service.startSandboxWorker("docker", runtime, input);
      expect(engine.startWorker).toHaveBeenCalledWith(runtime, input);
    });

    it("stopSandbox delegates to the resolved engine", async () => {
      await service.stopSandbox("docker", "container-1");
      expect(engine.stop).toHaveBeenCalledWith("container-1");
    });
  });

  describe("local provider facade", () => {
    it("launchLocal delegates to the local provider", () => {
      const input = { runId: "run-1", env: {} };
      const result = service.launchLocal(input);
      expect(localProvider.launch).toHaveBeenCalledWith(input);
      expect(result).toEqual({ runtimeInstanceId: "12345:token", channel: {} });
    });

    it("recoverOrphanLocal delegates to the local provider", async () => {
      await service.recoverOrphanLocal("12345:token");
      expect(localProvider.recoverOrphan).toHaveBeenCalledWith("12345:token");
    });
  });
});
