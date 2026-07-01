import { describe, it, expect, vi } from "vitest";
import { RuntimeInstanceLifecycleService } from "./lifecycle.service";
import { RuntimeProviderRegistry } from "../providers/provider-registry";

function makeResource(overrides: Record<string, unknown> = {}) {
  return {
    id: "rr-1",
    runtimeType: "sandbox",
    isolationScope: "workspace",
    ownerId: "ws-1",
    status: "running",
    ...overrides,
  };
}

function makeWorkerHost(overrides: Record<string, unknown> = {}) {
  return {
    findRuntimeBindingWithResource: vi.fn().mockResolvedValue(null),
    deleteRuntimeWorkspaceBinding: vi.fn().mockResolvedValue(undefined),
    findWorkspaceIdsByUser: vi.fn().mockResolvedValue([]),
    findRunningRuntimesByOwners: vi.fn().mockResolvedValue([]),
    markRuntimeStoppedById: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("RuntimeInstanceLifecycleService", () => {
  describe("shutdownForWorkspace", () => {
    it("shuts down a workspace-owned runtime resource and deletes the workspace binding", async () => {
      const shutdownRuntimeInstanceByOwnerId = vi.fn();
      const workerHost = makeWorkerHost({
        findRuntimeBindingWithResource: vi.fn().mockResolvedValue({
          id: "wr-1",
          workspaceId: "ws-1",
          resource: makeResource(),
        }),
      });
      const registry: Partial<RuntimeProviderRegistry> = {
        resolve: vi.fn().mockReturnValue({ shutdownRuntimeInstanceByOwnerId }),
      };
      const service = new RuntimeInstanceLifecycleService(
        workerHost as never,
        registry as RuntimeProviderRegistry
      );

      await service.shutdownForWorkspace("ws-1");

      expect(workerHost.findRuntimeBindingWithResource).toHaveBeenCalledWith(
        "ws-1"
      );
      expect(registry.resolve).toHaveBeenCalledWith("sandbox");
      expect(shutdownRuntimeInstanceByOwnerId).toHaveBeenCalledWith("ws-1");
      expect(workerHost.markRuntimeStoppedById).toHaveBeenCalledWith(
        expect.objectContaining({ id: "rr-1" }),
        "owner_released"
      );
      expect(workerHost.deleteRuntimeWorkspaceBinding).toHaveBeenCalledWith(
        "ws-1"
      );
    });

    it("does not stop a shared user-isolated resource when one workspace is deleted", async () => {
      const workerHost = makeWorkerHost({
        findRuntimeBindingWithResource: vi.fn().mockResolvedValue({
          id: "wr-1",
          workspaceId: "ws-1",
          resource: makeResource({ isolationScope: "user", ownerId: "user-1" }),
        }),
      });
      const registry: Partial<RuntimeProviderRegistry> = { resolve: vi.fn() };
      const service = new RuntimeInstanceLifecycleService(
        workerHost as never,
        registry as RuntimeProviderRegistry
      );

      await service.shutdownForWorkspace("ws-1");

      expect(registry.resolve).not.toHaveBeenCalled();
      expect(workerHost.markRuntimeStoppedById).not.toHaveBeenCalled();
      expect(workerHost.deleteRuntimeWorkspaceBinding).toHaveBeenCalledWith(
        "ws-1"
      );
    });

    it("marks legacy local runtime resources stopped without a registered provider", async () => {
      const workerHost = makeWorkerHost({
        findRuntimeBindingWithResource: vi.fn().mockResolvedValue({
          id: "wr-1",
          workspaceId: "ws-1",
          resource: makeResource({ runtimeType: "local" }),
        }),
      });
      const service = new RuntimeInstanceLifecycleService(
        workerHost as never,
        new RuntimeProviderRegistry([])
      );

      await service.shutdownForWorkspace("ws-1");

      expect(workerHost.markRuntimeStoppedById).toHaveBeenCalledWith(
        expect.objectContaining({ id: "rr-1", runtimeType: "local" }),
        "owner_released"
      );
      expect(workerHost.deleteRuntimeWorkspaceBinding).toHaveBeenCalledWith(
        "ws-1"
      );
    });
  });

  describe("shutdownForUser", () => {
    it("shuts down all runtime resources owned by the user (user-scope + workspace-scope)", async () => {
      const shutdownRuntimeInstanceByOwnerId = vi.fn();
      const workerHost = makeWorkerHost({
        findWorkspaceIdsByUser: vi.fn().mockResolvedValue([{ id: "ws-2" }]),
        findRunningRuntimesByOwners: vi.fn().mockResolvedValue([
          makeResource({
            id: "rr-user",
            isolationScope: "user",
            ownerId: "user-1",
          }),
          makeResource({ id: "rr-ws", ownerId: "ws-2" }),
        ]),
      });
      const registry: Partial<RuntimeProviderRegistry> = {
        resolve: vi.fn().mockReturnValue({ shutdownRuntimeInstanceByOwnerId }),
      };
      const service = new RuntimeInstanceLifecycleService(
        workerHost as never,
        registry as RuntimeProviderRegistry
      );

      await service.shutdownForUser("user-1");

      expect(workerHost.findWorkspaceIdsByUser).toHaveBeenCalledWith(
        "user-1"
      );
      expect(workerHost.findRunningRuntimesByOwners).toHaveBeenCalledWith([
        "user-1",
        "ws-2",
      ]);
      expect(shutdownRuntimeInstanceByOwnerId).toHaveBeenCalledWith("user-1");
      expect(shutdownRuntimeInstanceByOwnerId).toHaveBeenCalledWith("ws-2");
      expect(shutdownRuntimeInstanceByOwnerId).toHaveBeenCalledTimes(2);
      expect(workerHost.markRuntimeStoppedById).toHaveBeenCalledWith(
        expect.objectContaining({ id: "rr-user" }),
        "owner_released"
      );
      expect(workerHost.markRuntimeStoppedById).toHaveBeenCalledWith(
        expect.objectContaining({ id: "rr-ws" }),
        "owner_released"
      );
    });
  });

  it("logs a warning and continues when a provider throws", async () => {
    const workerHost = makeWorkerHost({
      findRunningRuntimesByOwners: vi
        .fn()
        .mockResolvedValue([
          makeResource({ id: "rr-1", ownerId: "ws-1" }),
          makeResource({ id: "rr-2", ownerId: "ws-2" }),
        ]),
    });
    const shutdownRuntimeInstanceByOwnerId = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("boom");
      })
      .mockImplementationOnce(() => undefined);
    const registry: Partial<RuntimeProviderRegistry> = {
      resolve: vi.fn().mockReturnValue({ shutdownRuntimeInstanceByOwnerId }),
    };
    const service = new RuntimeInstanceLifecycleService(
      workerHost as never,
      registry as RuntimeProviderRegistry
    );

    await expect(service.shutdownForUser("user-1")).resolves.toBeUndefined();
    expect(shutdownRuntimeInstanceByOwnerId).toHaveBeenCalledTimes(2);
  });
});
