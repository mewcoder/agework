import { describe, it, expect, vi } from "vitest";
import { RuntimeResourceLifecycleUseCase } from "./runtime-resource-lifecycle.use-case";
import { RuntimeProviderRegistry } from "../../providers/runtime-provider-registry";

function makeResource(overrides: Record<string, unknown> = {}) {
  return {
    id: "rr-1",
    runtimeType: "sandbox",
    isolationScope: "workspace",
    ownerUserId: "user-1",
    ownerWorkspaceId: "ws-1",
    status: "running",
    ...overrides,
  };
}

describe("RuntimeResourceLifecycleUseCase", () => {
  describe("shutdownForWorkspace", () => {
    it("shuts down a workspace-owned runtime resource and deletes the workspace binding", async () => {
      const shutdownRuntimeResource = vi.fn();
      const findUnique = vi.fn().mockResolvedValue({
        id: "wr-1",
        workspaceId: "ws-1",
        resource: makeResource(),
      });
      const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
      const registry: Partial<RuntimeProviderRegistry> = {
        resolve: vi.fn().mockReturnValue({ shutdownRuntimeResource }),
      };
      const service = new RuntimeResourceLifecycleUseCase(
        { workspaceRuntime: { findUnique, deleteMany } } as never,
        registry as RuntimeProviderRegistry
      );

      await service.shutdownForWorkspace("ws-1");

      expect(findUnique).toHaveBeenCalledWith({
        where: { workspaceId: "ws-1" },
        include: { resource: true },
      });
      expect(registry.resolve).toHaveBeenCalledWith("sandbox");
      expect(shutdownRuntimeResource).toHaveBeenCalledWith("ws-1");
      expect(deleteMany).toHaveBeenCalledWith({ where: { workspaceId: "ws-1" } });
    });

    it("does not stop a shared user-isolated resource when one workspace is deleted", async () => {
      const shutdownRuntimeResource = vi.fn();
      const findUnique = vi.fn().mockResolvedValue({
        id: "wr-1",
        workspaceId: "ws-1",
        resource: makeResource({
          isolationScope: "user",
          ownerWorkspaceId: null,
        }),
      });
      const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
      const registry: Partial<RuntimeProviderRegistry> = {
        resolve: vi.fn().mockReturnValue({ shutdownRuntimeResource }),
      };
      const service = new RuntimeResourceLifecycleUseCase(
        { workspaceRuntime: { findUnique, deleteMany } } as never,
        registry as RuntimeProviderRegistry
      );

      await service.shutdownForWorkspace("ws-1");

      expect(registry.resolve).not.toHaveBeenCalled();
      expect(deleteMany).toHaveBeenCalledWith({ where: { workspaceId: "ws-1" } });
    });
  });

  describe("shutdownForUser", () => {
    it("shuts down all runtime resources owned by the user", async () => {
      const shutdownRuntimeResource = vi.fn();
      const findMany = vi.fn().mockResolvedValue([
        makeResource({
          id: "rr-user",
          isolationScope: "user",
          ownerUserId: "user-1",
          ownerWorkspaceId: null,
        }),
        makeResource({ id: "rr-ws", ownerWorkspaceId: "ws-2" }),
      ]);
      const registry: Partial<RuntimeProviderRegistry> = {
        resolve: vi.fn().mockReturnValue({ shutdownRuntimeResource }),
      };
      const service = new RuntimeResourceLifecycleUseCase(
        { runtimeResource: { findMany } } as never,
        registry as RuntimeProviderRegistry
      );

      await service.shutdownForUser("user-1");

      expect(findMany).toHaveBeenCalledWith({
        where: { ownerUserId: "user-1", status: "running" },
      });
      expect(shutdownRuntimeResource).toHaveBeenCalledWith("user-1");
      expect(shutdownRuntimeResource).toHaveBeenCalledWith("ws-2");
      expect(shutdownRuntimeResource).toHaveBeenCalledTimes(2);
    });
  });

  it("logs a warning and continues when a provider throws", async () => {
    const findMany = vi.fn().mockResolvedValue([
      makeResource({ id: "rr-1", ownerWorkspaceId: "ws-1" }),
      makeResource({ id: "rr-2", ownerWorkspaceId: "ws-2" }),
    ]);
    const shutdownRuntimeResource = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("boom");
      })
      .mockImplementationOnce(() => undefined);
    const registry: Partial<RuntimeProviderRegistry> = {
      resolve: vi.fn().mockReturnValue({ shutdownRuntimeResource }),
    };
    const service = new RuntimeResourceLifecycleUseCase(
      { runtimeResource: { findMany } } as never,
      registry as RuntimeProviderRegistry
    );

    await expect(service.shutdownForUser("user-1")).resolves.toBeUndefined();
    expect(shutdownRuntimeResource).toHaveBeenCalledTimes(2);
  });
});
