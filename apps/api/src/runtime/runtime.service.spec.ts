import { describe, it, expect, vi, beforeEach } from "vitest";
import { RuntimeService } from "./runtime.service";
import { RuntimeProviderRegistry } from "./providers/provider-registry";
import { SandboxRuntimeInstanceService } from "./sandbox/sandbox-instance.service";
import { ConfigService } from "../config/config.service";
import type { RuntimeProvider } from "./providers/provider-contracts";

describe("RuntimeService", () => {
  let configService: Partial<ConfigService>;
  let providerRegistry: RuntimeProviderRegistry;
  let resolveSpy: ReturnType<typeof vi.spyOn>;
  let sandboxProvider: RuntimeProvider;
  let shutdownRuntimeInstanceByOwnerId: ReturnType<typeof vi.fn>;
  let workerHost: Record<string, ReturnType<typeof vi.fn>>;
  let sandboxInstances: {
    acquireInstanceForRun: ReturnType<typeof vi.fn>;
    releaseInstanceForRun: ReturnType<typeof vi.fn>;
    recoverOrphan: ReturnType<typeof vi.fn>;
  };
  let service: RuntimeService;

  beforeEach(() => {
    shutdownRuntimeInstanceByOwnerId = vi.fn((_ownerId: string) => undefined);
    sandboxProvider = {
      type: "sandbox",
      recoverOrphan: vi.fn(async (_runtimeInstanceId: string) => undefined),
      shutdownRuntimeInstanceByOwnerId: shutdownRuntimeInstanceByOwnerId as (
        ownerId: string
      ) => void,
    };
    configService = {
      getDefaultRuntimeType: vi.fn().mockReturnValue("local"),
      getDefaultIsolationScope: vi.fn().mockReturnValue("user"),
      getSandboxEngine: vi.fn().mockReturnValue("docker"),
      getAllowedRuntimeTypes: vi.fn().mockReturnValue(["local", "sandbox"]),
      getAllowedIsolationScopes: vi.fn().mockReturnValue(["user", "workspace"]),
      getIdleTimeoutSeconds: vi.fn().mockReturnValue(600),
    };
    workerHost = {
      countRunningRuntimes: vi.fn().mockResolvedValue(0),
      listRuntimeResourcesPage: vi
        .fn()
        .mockResolvedValue({ items: [], total: 0 }),
      findRuntimeById: vi.fn().mockResolvedValue(null),
      markRuntimeStoppedById: vi.fn().mockResolvedValue(undefined),
      findRuntimeByRuntimeId: vi.fn().mockResolvedValue(null),
      // 直接透传 metadata 当诊断信息:测试只关心 toRuntimeInstanceResponse 有没有
      // 正确调用并合并结果,不重复验证 runtimeInstanceDiagnostics 自己的提取逻辑
      // (那部分已在 worker-registry-metadata.spec.ts 里测过)。
      buildRuntimeDiagnostics: vi.fn((metadata) => metadata as never),
    };
    providerRegistry = new RuntimeProviderRegistry([sandboxProvider]);
    resolveSpy = vi.spyOn(providerRegistry, "resolve");
    sandboxInstances = {
      acquireInstanceForRun: vi
        .fn()
        .mockResolvedValue({ outcome: "cancelledBeforeReady" }),
      releaseInstanceForRun: vi.fn(),
      recoverOrphan: vi.fn().mockResolvedValue(undefined),
    };
    service = new RuntimeService(
      configService as ConfigService,
      providerRegistry,
      workerHost as never,
      sandboxInstances as unknown as SandboxRuntimeInstanceService
    );
  });

  it("acquireInstanceForRun delegates to the sandbox instance service", async () => {
    const input = { runConfig: { runId: "run-1" } } as never;
    await service.acquireInstanceForRun(input);
    expect(sandboxInstances.acquireInstanceForRun).toHaveBeenCalledWith(input);
  });

  it("releaseInstanceForRun delegates to the sandbox instance service", () => {
    service.releaseInstanceForRun("run-1");
    expect(sandboxInstances.releaseInstanceForRun).toHaveBeenCalledWith(
      "run-1"
    );
  });

  it("recoverOrphanInstance delegates to the sandbox instance service", async () => {
    await service.recoverOrphanInstance("inst-1");
    expect(sandboxInstances.recoverOrphan).toHaveBeenCalledWith("inst-1");
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

  it("shutdownRuntimeInstanceByOwnerId dispatches to the resolved provider by type", () => {
    service.shutdownRuntimeInstanceByOwnerId("sandbox", "ws-1");
    expect(resolveSpy).toHaveBeenCalledWith("sandbox");
    expect(shutdownRuntimeInstanceByOwnerId).toHaveBeenCalledWith("ws-1");
  });

  it("shutdownRuntimeInstanceByOwnerId resolves local to the registry no-op provider", () => {
    shutdownRuntimeInstanceByOwnerId.mockClear();

    service.shutdownRuntimeInstanceByOwnerId("local", "ws-1");
    expect(resolveSpy).toHaveBeenCalledWith("local");
    expect(shutdownRuntimeInstanceByOwnerId).not.toHaveBeenCalled();
  });

  it("getRuntimeStats reports the running resource count", async () => {
    workerHost.countRunningRuntimes.mockResolvedValue(3);
    await expect(service.getRuntimeStats()).resolves.toEqual({
      activeRuntimes: 3,
    });
  });

  it("listResources maps rows to the admin response shape", async () => {
    workerHost.listRuntimeResourcesPage.mockResolvedValue({
      items: [
        {
          id: "rr-1",
          runtimeType: "sandbox",
          isolationScope: "workspace",
          ownerId: "ws-1",
          runtimeInstanceId: "container-abc",
          status: "running",
          expiresAt: null,
          metadata: {
            ownerId: "ws-1",
            statusReason: "running",
            lastSeenAt: "2026-06-25T00:00:00.000Z",
          },
          createdAt: new Date("2026-06-25T00:00:00.000Z"),
          updatedAt: new Date("2026-06-25T00:01:00.000Z"),
          workspaceRuntimeInstances: [
            {
              id: "wr-1",
              workspaceId: "ws-1",
              createdAt: new Date("2026-06-25T00:00:00.000Z"),
              updatedAt: new Date("2026-06-25T00:01:00.000Z"),
            },
          ],
        },
      ],
      total: 1,
    });

    const result = await service.listResources({
      status: "running",
      pageNo: 1,
      pageSize: 10,
    });

    expect(workerHost.listRuntimeResourcesPage).toHaveBeenCalledWith(
      expect.objectContaining({ status: "running" })
    );
    expect(result.total).toBe(1);
    expect(result.list[0]).toMatchObject({
      id: "rr-1",
      ownerId: "ws-1",
      workspaceCount: 1,
      isReusable: true,
      diagnostics: {
        ownerId: "ws-1",
        statusReason: "running",
        runtimeInstanceId: "container-abc",
      },
      createdAt: "2026-06-25T00:00:00.000Z",
      updatedAt: "2026-06-25T00:01:00.000Z",
    });
    expect(result.list[0]).not.toHaveProperty("workspaceRuntimeInstances");
  });

  it("stopRuntimeInstance shuts down the provider and marks the row stopped", async () => {
    workerHost.findRuntimeById.mockResolvedValue({
      id: "rr-1",
      runtimeType: "sandbox",
      isolationScope: "workspace",
      ownerId: "ws-1",
      status: "running",
    });

    await expect(service.stopRuntimeInstance("rr-1")).resolves.toEqual({
      ok: true,
    });
    expect(resolveSpy).toHaveBeenCalledWith("sandbox");
    expect(shutdownRuntimeInstanceByOwnerId).toHaveBeenCalledWith("ws-1");
    expect(workerHost.markRuntimeStoppedById).toHaveBeenCalledWith(
      expect.objectContaining({ id: "rr-1" }),
      "manual_stop"
    );
  });

  it("stopRuntimeInstance throws when the resource is missing or not running", async () => {
    workerHost.findRuntimeById.mockResolvedValue({ status: "stopped" });
    await expect(service.stopRuntimeInstance("rr-1")).rejects.toThrow(
      "not found or not running"
    );
    expect(workerHost.markRuntimeStoppedById).not.toHaveBeenCalled();
  });

  it("isRuntimeInstanceUserScoped reports whether the resource is user-isolated", async () => {
    workerHost.findRuntimeByRuntimeId.mockResolvedValue({
      isolationScope: "user",
    });
    await expect(
      service.isRuntimeInstanceUserScoped("sandbox", "container-1")
    ).resolves.toBe(true);
    workerHost.findRuntimeByRuntimeId.mockResolvedValue({
      isolationScope: "workspace",
    });
    await expect(
      service.isRuntimeInstanceUserScoped("sandbox", "container-1")
    ).resolves.toBe(false);
  });
});
