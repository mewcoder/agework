import { describe, it, expect, vi, beforeEach } from "vitest";
import { RuntimeService } from "./runtime.service";
import { RuntimeProviderRegistry } from "./providers/provider-registry";
import { ConfigService } from "../config/config.service";
import type { RuntimeProvider } from "./providers/provider-contracts";

describe("RuntimeService", () => {
  let configService: Partial<ConfigService>;
  let providerRegistry: RuntimeProviderRegistry;
  let resolveSpy: ReturnType<typeof vi.spyOn>;
  let sandboxProvider: RuntimeProvider;
  let shutdownRuntimeInstance: ReturnType<typeof vi.fn>;
  let repository: Record<string, ReturnType<typeof vi.fn>>;
  let service: RuntimeService;

  beforeEach(() => {
    shutdownRuntimeInstance = vi.fn((_ownerId: string) => undefined);
    sandboxProvider = {
      type: "sandbox",
      recoverOrphan: vi.fn(async (_runtimeInstanceId: string) => undefined),
      shutdownRuntimeInstance: shutdownRuntimeInstance as (ownerId: string) => void,
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
    };
    providerRegistry = new RuntimeProviderRegistry([sandboxProvider]);
    resolveSpy = vi.spyOn(providerRegistry, "resolve");
    service = new RuntimeService(
      configService as ConfigService,
      providerRegistry,
      repository as never
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

  it("listRuntimeResources maps rows to the admin response shape", async () => {
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

    const result = await service.listRuntimeResources({
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
});
