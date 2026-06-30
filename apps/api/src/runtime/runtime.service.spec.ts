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
  let shutdownRuntimeInstance: ReturnType<typeof vi.fn>;
  let repository: Record<string, ReturnType<typeof vi.fn>>;
  let sandboxInstances: {
    acquireInstanceForRun: ReturnType<typeof vi.fn>;
    releaseInstanceForRun: ReturnType<typeof vi.fn>;
    recoverOrphan: ReturnType<typeof vi.fn>;
  };
  let service: RuntimeService;

  beforeEach(() => {
    shutdownRuntimeInstance = vi.fn((_ownerId: string) => undefined);
    sandboxProvider = {
      type: "sandbox",
      recoverOrphan: vi.fn(async (_runtimeInstanceId: string) => undefined),
      shutdownRuntimeInstance: shutdownRuntimeInstance as (
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
    repository = {
      countRunning: vi.fn().mockResolvedValue(0),
      listResourcesPage: vi.fn().mockResolvedValue({ items: [], total: 0 }),
      findById: vi.fn().mockResolvedValue(null),
      markStoppedById: vi.fn().mockResolvedValue(undefined),
      findAllRunning: vi.fn().mockResolvedValue([]),
      findByRuntimeId: vi.fn().mockResolvedValue(null),
      userExists: vi.fn().mockResolvedValue(true),
      deleteStaleResources: vi.fn().mockResolvedValue({ count: 0 }),
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
      repository as never,
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

  it("shutdownRuntimeInstance dispatches to the resolved provider by type", () => {
    service.shutdownRuntimeInstance("sandbox", "ws-1");
    expect(resolveSpy).toHaveBeenCalledWith("sandbox");
    expect(shutdownRuntimeInstance).toHaveBeenCalledWith("ws-1");
  });

  it("shutdownRuntimeInstance resolves local to the registry no-op provider", () => {
    shutdownRuntimeInstance.mockClear();

    service.shutdownRuntimeInstance("local", "ws-1");
    expect(resolveSpy).toHaveBeenCalledWith("local");
    expect(shutdownRuntimeInstance).not.toHaveBeenCalled();
  });

  it("getRuntimeStats reports the running resource count", async () => {
    repository.countRunning.mockResolvedValue(3);
    await expect(service.getRuntimeStats()).resolves.toEqual({
      activeRuntimes: 3,
    });
  });

  it("listResources maps rows to the admin response shape", async () => {
    repository.listResourcesPage.mockResolvedValue({
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

    expect(repository.listResourcesPage).toHaveBeenCalledWith(
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
    repository.findById.mockResolvedValue({
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
    expect(shutdownRuntimeInstance).toHaveBeenCalledWith("ws-1");
    expect(repository.markStoppedById).toHaveBeenCalledWith(
      expect.objectContaining({ id: "rr-1" }),
      "manual_stop"
    );
  });

  it("stopRuntimeInstance throws when the resource is missing or not running", async () => {
    repository.findById.mockResolvedValue({ status: "stopped" });
    await expect(service.stopRuntimeInstance("rr-1")).rejects.toThrow(
      "not found or not running"
    );
    expect(repository.markStoppedById).not.toHaveBeenCalled();
  });

  it("isRuntimeInstanceUserScoped reports whether the resource is user-isolated", async () => {
    repository.findByRuntimeId.mockResolvedValue({ isolationScope: "user" });
    await expect(
      service.isRuntimeInstanceUserScoped("sandbox", "container-1")
    ).resolves.toBe(true);
    repository.findByRuntimeId.mockResolvedValue({
      isolationScope: "workspace",
    });
    await expect(
      service.isRuntimeInstanceUserScoped("sandbox", "container-1")
    ).resolves.toBe(false);
  });

  it("recoverOrphanRuntimeInstances stops running resources and marks them stopped", async () => {
    repository.findAllRunning.mockResolvedValue([
      {
        id: "rr-1",
        runtimeType: "sandbox",
        isolationScope: "workspace",
        ownerId: "ws-1",
        runtimeInstanceId: "container-ws1",
      },
    ]);
    const recoverOrphan = vi.fn().mockResolvedValue(undefined);
    resolveSpy.mockReturnValue({ recoverOrphan });

    await service.recoverOrphanRuntimeInstances();

    expect(resolveSpy).toHaveBeenCalledWith("sandbox");
    expect(recoverOrphan).toHaveBeenCalledWith("container-ws1");
    expect(repository.markStoppedById).toHaveBeenCalledWith(
      expect.objectContaining({ id: "rr-1" }),
      "orphan_recovered"
    );
  });

  it("recoverOrphanRuntimeInstances keeps user-scope resources whose owner still exists", async () => {
    repository.findAllRunning.mockResolvedValue([
      {
        id: "rr-user",
        runtimeType: "sandbox",
        isolationScope: "user",
        ownerId: "user-1",
        runtimeInstanceId: "container-user1",
      },
    ]);
    repository.userExists.mockResolvedValue(true);
    const recoverOrphan = vi.fn();
    resolveSpy.mockReturnValue({ recoverOrphan });

    await service.recoverOrphanRuntimeInstances();

    expect(recoverOrphan).not.toHaveBeenCalled();
    expect(repository.markStoppedById).not.toHaveBeenCalled();
  });

  it("cleanupStaleRuntimeInstances delegates to the repository", async () => {
    repository.deleteStaleResources.mockResolvedValue({ count: 2 });
    await service.cleanupStaleRuntimeInstances();
    expect(repository.deleteStaleResources).toHaveBeenCalled();
  });
});
