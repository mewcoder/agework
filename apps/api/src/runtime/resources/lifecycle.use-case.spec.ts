import { describe, it, expect, vi } from "vitest";
import { RuntimeInstanceLifecycleUseCase } from "./lifecycle.use-case";
import { RuntimeProviderRegistry } from "../providers/provider-registry";

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

describe("RuntimeInstanceLifecycleUseCase", () => {
  describe("shutdownForWorkspace", () => {
    it("shuts down a workspace-owned runtime resource and deletes the workspace binding", async () => {
      const shutdownRuntimeInstance = vi.fn();
      const findUnique = vi.fn().mockResolvedValue({
        id: "wr-1",
        workspaceId: "ws-1",
        resource: makeResource(),
      });
      const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
      const update = vi.fn().mockResolvedValue({});
      const registry: Partial<RuntimeProviderRegistry> = {
        resolve: vi.fn().mockReturnValue({ shutdownRuntimeInstance }),
      };
      const service = new RuntimeInstanceLifecycleUseCase(
        {
          workspaceRuntimeInstance: { findUnique, deleteMany },
          runtimeInstance: { update },
        } as never,
        registry as RuntimeProviderRegistry
      );

      await service.shutdownForWorkspace("ws-1");

      expect(findUnique).toHaveBeenCalledWith({
        where: { workspaceId: "ws-1" },
        include: { resource: true },
      });
      expect(registry.resolve).toHaveBeenCalledWith("sandbox");
      expect(shutdownRuntimeInstance).toHaveBeenCalledWith("ws-1");
      expect(update).toHaveBeenCalledWith({
        where: { id: "rr-1" },
        data: {
          status: "stopped",
          metadata: expect.objectContaining({
            scopeKey: "ws-1",
            statusReason: "owner_released",
            stoppedAt: expect.any(String),
          }),
        },
      });
      expect(deleteMany).toHaveBeenCalledWith({
        where: { workspaceId: "ws-1" },
      });
    });

    it("does not stop a shared user-isolated resource when one workspace is deleted", async () => {
      const shutdownRuntimeInstance = vi.fn();
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
        resolve: vi.fn().mockReturnValue({ shutdownRuntimeInstance }),
      };
      const service = new RuntimeInstanceLifecycleUseCase(
        { workspaceRuntimeInstance: { findUnique, deleteMany } } as never,
        registry as RuntimeProviderRegistry
      );

      await service.shutdownForWorkspace("ws-1");

      expect(registry.resolve).not.toHaveBeenCalled();
      expect(deleteMany).toHaveBeenCalledWith({
        where: { workspaceId: "ws-1" },
      });
    });
  });

  describe("shutdownForUser", () => {
    it("shuts down all runtime resources owned by the user", async () => {
      const shutdownRuntimeInstance = vi.fn();
      const findMany = vi.fn().mockResolvedValue([
        makeResource({
          id: "rr-user",
          isolationScope: "user",
          ownerUserId: "user-1",
          ownerWorkspaceId: null,
        }),
        makeResource({ id: "rr-ws", ownerWorkspaceId: "ws-2" }),
      ]);
      const update = vi.fn().mockResolvedValue({});
      const registry: Partial<RuntimeProviderRegistry> = {
        resolve: vi.fn().mockReturnValue({ shutdownRuntimeInstance }),
      };
      const service = new RuntimeInstanceLifecycleUseCase(
        { runtimeInstance: { findMany, update } } as never,
        registry as RuntimeProviderRegistry
      );

      await service.shutdownForUser("user-1");

      expect(findMany).toHaveBeenCalledWith({
        where: { ownerUserId: "user-1", status: "running" },
      });
      expect(shutdownRuntimeInstance).toHaveBeenCalledWith("user-1");
      expect(shutdownRuntimeInstance).toHaveBeenCalledWith("ws-2");
      expect(shutdownRuntimeInstance).toHaveBeenCalledTimes(2);
      expect(update).toHaveBeenCalledWith({
        where: { id: "rr-user" },
        data: {
          status: "stopped",
          metadata: expect.objectContaining({
            scopeKey: "user-1",
            statusReason: "owner_released",
          }),
        },
      });
      expect(update).toHaveBeenCalledWith({
        where: { id: "rr-ws" },
        data: {
          status: "stopped",
          metadata: expect.objectContaining({
            scopeKey: "ws-2",
            statusReason: "owner_released",
          }),
        },
      });
    });
  });

  it("logs a warning and continues when a provider throws", async () => {
    const findMany = vi
      .fn()
      .mockResolvedValue([
        makeResource({ id: "rr-1", ownerWorkspaceId: "ws-1" }),
        makeResource({ id: "rr-2", ownerWorkspaceId: "ws-2" }),
      ]);
    const shutdownRuntimeInstance = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("boom");
      })
      .mockImplementationOnce(() => undefined);
    const registry: Partial<RuntimeProviderRegistry> = {
      resolve: vi.fn().mockReturnValue({ shutdownRuntimeInstance }),
    };
    const service = new RuntimeInstanceLifecycleUseCase(
      { runtimeInstance: { findMany, update: vi.fn() } } as never,
      registry as RuntimeProviderRegistry
    );

    await expect(service.shutdownForUser("user-1")).resolves.toBeUndefined();
    expect(shutdownRuntimeInstance).toHaveBeenCalledTimes(2);
  });
});
