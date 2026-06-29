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

function makeRepo(overrides: Record<string, unknown> = {}) {
  return {
    findBindingWithResource: vi.fn().mockResolvedValue(null),
    deleteWorkspaceBinding: vi.fn().mockResolvedValue(undefined),
    findWorkspaceIdsByUser: vi.fn().mockResolvedValue([]),
    findRunningByOwners: vi.fn().mockResolvedValue([]),
    markStoppedById: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("RuntimeInstanceLifecycleService", () => {
  describe("shutdownForWorkspace", () => {
    it("shuts down a workspace-owned runtime resource and deletes the workspace binding", async () => {
      const shutdownRuntimeInstance = vi.fn();
      const repo = makeRepo({
        findBindingWithResource: vi.fn().mockResolvedValue({
          id: "wr-1",
          workspaceId: "ws-1",
          resource: makeResource(),
        }),
      });
      const registry: Partial<RuntimeProviderRegistry> = {
        resolve: vi.fn().mockReturnValue({ shutdownRuntimeInstance }),
      };
      const service = new RuntimeInstanceLifecycleService(
        repo as never,
        registry as RuntimeProviderRegistry
      );

      await service.shutdownForWorkspace("ws-1");

      expect(repo.findBindingWithResource).toHaveBeenCalledWith("ws-1");
      expect(registry.resolve).toHaveBeenCalledWith("sandbox");
      expect(shutdownRuntimeInstance).toHaveBeenCalledWith("ws-1");
      expect(repo.markStoppedById).toHaveBeenCalledWith(
        expect.objectContaining({ id: "rr-1" }),
        "owner_released"
      );
      expect(repo.deleteWorkspaceBinding).toHaveBeenCalledWith("ws-1");
    });

    it("does not stop a shared user-isolated resource when one workspace is deleted", async () => {
      const repo = makeRepo({
        findBindingWithResource: vi.fn().mockResolvedValue({
          id: "wr-1",
          workspaceId: "ws-1",
          resource: makeResource({ isolationScope: "user", ownerId: "user-1" }),
        }),
      });
      const registry: Partial<RuntimeProviderRegistry> = { resolve: vi.fn() };
      const service = new RuntimeInstanceLifecycleService(
        repo as never,
        registry as RuntimeProviderRegistry
      );

      await service.shutdownForWorkspace("ws-1");

      expect(registry.resolve).not.toHaveBeenCalled();
      expect(repo.markStoppedById).not.toHaveBeenCalled();
      expect(repo.deleteWorkspaceBinding).toHaveBeenCalledWith("ws-1");
    });

    it("marks legacy local runtime resources stopped without a registered provider", async () => {
      const repo = makeRepo({
        findBindingWithResource: vi.fn().mockResolvedValue({
          id: "wr-1",
          workspaceId: "ws-1",
          resource: makeResource({ runtimeType: "local" }),
        }),
      });
      const service = new RuntimeInstanceLifecycleService(
        repo as never,
        new RuntimeProviderRegistry([])
      );

      await service.shutdownForWorkspace("ws-1");

      expect(repo.markStoppedById).toHaveBeenCalledWith(
        expect.objectContaining({ id: "rr-1", runtimeType: "local" }),
        "owner_released"
      );
      expect(repo.deleteWorkspaceBinding).toHaveBeenCalledWith("ws-1");
    });
  });

  describe("shutdownForUser", () => {
    it("shuts down all runtime resources owned by the user (user-scope + workspace-scope)", async () => {
      const shutdownRuntimeInstance = vi.fn();
      const repo = makeRepo({
        findWorkspaceIdsByUser: vi.fn().mockResolvedValue([{ id: "ws-2" }]),
        findRunningByOwners: vi.fn().mockResolvedValue([
          makeResource({
            id: "rr-user",
            isolationScope: "user",
            ownerId: "user-1",
          }),
          makeResource({ id: "rr-ws", ownerId: "ws-2" }),
        ]),
      });
      const registry: Partial<RuntimeProviderRegistry> = {
        resolve: vi.fn().mockReturnValue({ shutdownRuntimeInstance }),
      };
      const service = new RuntimeInstanceLifecycleService(
        repo as never,
        registry as RuntimeProviderRegistry
      );

      await service.shutdownForUser("user-1");

      expect(repo.findWorkspaceIdsByUser).toHaveBeenCalledWith("user-1");
      expect(repo.findRunningByOwners).toHaveBeenCalledWith(["user-1", "ws-2"]);
      expect(shutdownRuntimeInstance).toHaveBeenCalledWith("user-1");
      expect(shutdownRuntimeInstance).toHaveBeenCalledWith("ws-2");
      expect(shutdownRuntimeInstance).toHaveBeenCalledTimes(2);
      expect(repo.markStoppedById).toHaveBeenCalledWith(
        expect.objectContaining({ id: "rr-user" }),
        "owner_released"
      );
      expect(repo.markStoppedById).toHaveBeenCalledWith(
        expect.objectContaining({ id: "rr-ws" }),
        "owner_released"
      );
    });
  });

  it("logs a warning and continues when a provider throws", async () => {
    const repo = makeRepo({
      findRunningByOwners: vi
        .fn()
        .mockResolvedValue([
          makeResource({ id: "rr-1", ownerId: "ws-1" }),
          makeResource({ id: "rr-2", ownerId: "ws-2" }),
        ]),
    });
    const shutdownRuntimeInstance = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("boom");
      })
      .mockImplementationOnce(() => undefined);
    const registry: Partial<RuntimeProviderRegistry> = {
      resolve: vi.fn().mockReturnValue({ shutdownRuntimeInstance }),
    };
    const service = new RuntimeInstanceLifecycleService(
      repo as never,
      registry as RuntimeProviderRegistry
    );

    await expect(service.shutdownForUser("user-1")).resolves.toBeUndefined();
    expect(shutdownRuntimeInstance).toHaveBeenCalledTimes(2);
  });
});
