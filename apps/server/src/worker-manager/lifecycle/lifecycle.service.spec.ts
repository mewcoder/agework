import { describe, it, expect, vi } from "vitest";
import { RuntimeInstanceLifecycleService } from "./lifecycle.service";

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

function makeRegistry(overrides: Record<string, unknown> = {}) {
  return {
    findBindingWithResource: vi.fn().mockResolvedValue(null),
    deleteWorkspaceBinding: vi.fn().mockResolvedValue(undefined),
    findWorkspaceIdsByUser: vi.fn().mockResolvedValue([]),
    findRunningByOwners: vi.fn().mockResolvedValue([]),
    markStoppedById: vi.fn().mockResolvedValue(undefined),
    markAllStartingAsError: vi.fn().mockResolvedValue(undefined),
    findRunningByRuntimeType: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function makeSandboxInstances(overrides: Record<string, unknown> = {}) {
  return {
    shutdownRuntimeInstanceByOwnerId: vi.fn(),
    ...overrides,
  };
}

function makeLocalInstances(overrides: Record<string, unknown> = {}) {
  return {
    shutdownRuntimeInstanceByOwnerId: vi.fn(),
    recoverOrphan: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("RuntimeInstanceLifecycleService", () => {
  describe("shutdownForWorkspace", () => {
    it("shuts down a workspace-owned sandbox resource and deletes the workspace binding", async () => {
      const registry = makeRegistry({
        findBindingWithResource: vi.fn().mockResolvedValue({
          id: "wr-1",
          workspaceId: "ws-1",
          workerInstance: makeResource(),
        }),
      });
      const sandboxInstances = makeSandboxInstances();
      const localInstances = makeLocalInstances();
      const service = new RuntimeInstanceLifecycleService(
        registry as never,
        sandboxInstances as never,
        localInstances as never
      );

      await service.shutdownForWorkspace("ws-1");

      expect(registry.findBindingWithResource).toHaveBeenCalledWith("ws-1");
      expect(
        sandboxInstances.shutdownRuntimeInstanceByOwnerId
      ).toHaveBeenCalledWith("ws-1");
      expect(registry.markStoppedById).toHaveBeenCalledWith(
        expect.objectContaining({ id: "rr-1" }),
        "owner_released"
      );
      expect(registry.deleteWorkspaceBinding).toHaveBeenCalledWith("ws-1");
    });

    it("does not stop a shared user-isolated resource when one workspace is deleted", async () => {
      const registry = makeRegistry({
        findBindingWithResource: vi.fn().mockResolvedValue({
          id: "wr-1",
          workspaceId: "ws-1",
          workerInstance: makeResource({
            isolationScope: "user",
            ownerId: "user-1",
          }),
        }),
      });
      const sandboxInstances = makeSandboxInstances();
      const localInstances = makeLocalInstances();
      const service = new RuntimeInstanceLifecycleService(
        registry as never,
        sandboxInstances as never,
        localInstances as never
      );

      await service.shutdownForWorkspace("ws-1");

      expect(
        sandboxInstances.shutdownRuntimeInstanceByOwnerId
      ).not.toHaveBeenCalled();
      expect(registry.markStoppedById).not.toHaveBeenCalled();
      expect(registry.deleteWorkspaceBinding).toHaveBeenCalledWith("ws-1");
    });

    it("shuts down a workspace-owned local resource by calling the local executor", async () => {
      const registry = makeRegistry({
        findBindingWithResource: vi.fn().mockResolvedValue({
          id: "wr-1",
          workspaceId: "ws-1",
          workerInstance: makeResource({ runtimeType: "local" }),
        }),
      });
      const sandboxInstances = makeSandboxInstances();
      const localInstances = makeLocalInstances();
      const service = new RuntimeInstanceLifecycleService(
        registry as never,
        sandboxInstances as never,
        localInstances as never
      );

      await service.shutdownForWorkspace("ws-1");

      expect(
        sandboxInstances.shutdownRuntimeInstanceByOwnerId
      ).not.toHaveBeenCalled();
      expect(
        localInstances.shutdownRuntimeInstanceByOwnerId
      ).toHaveBeenCalledWith("ws-1");
      expect(registry.markStoppedById).toHaveBeenCalledWith(
        expect.objectContaining({ id: "rr-1", runtimeType: "local" }),
        "owner_released"
      );
      expect(registry.deleteWorkspaceBinding).toHaveBeenCalledWith("ws-1");
    });
  });

  describe("shutdownForUser", () => {
    it("shuts down all sandbox resources owned by the user (user-scope + workspace-scope)", async () => {
      const registry = makeRegistry({
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
      const sandboxInstances = makeSandboxInstances();
      const localInstances = makeLocalInstances();
      const service = new RuntimeInstanceLifecycleService(
        registry as never,
        sandboxInstances as never,
        localInstances as never
      );

      await service.shutdownForUser("user-1");

      expect(registry.findWorkspaceIdsByUser).toHaveBeenCalledWith("user-1");
      expect(registry.findRunningByOwners).toHaveBeenCalledWith([
        "user-1",
        "ws-2",
      ]);
      expect(
        sandboxInstances.shutdownRuntimeInstanceByOwnerId
      ).toHaveBeenCalledWith("user-1");
      expect(
        sandboxInstances.shutdownRuntimeInstanceByOwnerId
      ).toHaveBeenCalledWith("ws-2");
      expect(
        sandboxInstances.shutdownRuntimeInstanceByOwnerId
      ).toHaveBeenCalledTimes(2);
      expect(registry.markStoppedById).toHaveBeenCalledWith(
        expect.objectContaining({ id: "rr-user" }),
        "owner_released"
      );
      expect(registry.markStoppedById).toHaveBeenCalledWith(
        expect.objectContaining({ id: "rr-ws" }),
        "owner_released"
      );
    });
  });

  it("logs a warning and continues when the sandbox executor throws", async () => {
    const registry = makeRegistry({
      findRunningByOwners: vi
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
    const sandboxInstances = makeSandboxInstances({
      shutdownRuntimeInstanceByOwnerId,
    });
    const localInstances = makeLocalInstances();
    const service = new RuntimeInstanceLifecycleService(
      registry as never,
      sandboxInstances as never,
      localInstances as never
    );

    await expect(service.shutdownForUser("user-1")).resolves.toBeUndefined();
    expect(shutdownRuntimeInstanceByOwnerId).toHaveBeenCalledTimes(2);
  });
});

describe("onApplicationBootstrap", () => {
  it("marks all starting rows as error, then recovers orphaned local rows", async () => {
    const registry = makeRegistry({
      findRunningByRuntimeType: vi.fn().mockResolvedValue([
        {
          id: "rr-1",
          runtimeType: "local",
          isolationScope: "workspace",
          ownerId: "ws-1",
          runtimeInstanceId: "4242:token",
        },
        {
          id: "rr-2",
          runtimeType: "local",
          isolationScope: "workspace",
          ownerId: "ws-2",
          runtimeInstanceId: "5555:token",
        },
      ]),
    });
    const sandboxInstances = makeSandboxInstances();
    const localInstances = makeLocalInstances({
      recoverOrphan: vi.fn().mockResolvedValue(undefined),
    });
    const service = new RuntimeInstanceLifecycleService(
      registry as never,
      sandboxInstances as never,
      localInstances as never
    );

    await service.onApplicationBootstrap();

    expect(registry.markAllStartingAsError).toHaveBeenCalledTimes(1);
    expect(registry.findRunningByRuntimeType).toHaveBeenCalledWith("local");
    expect(localInstances.recoverOrphan).toHaveBeenCalledWith("4242:token");
    expect(localInstances.recoverOrphan).toHaveBeenCalledWith("5555:token");
    expect(registry.markStoppedById).toHaveBeenCalledWith(
      expect.objectContaining({ id: "rr-1" }),
      "interrupted_by_restart"
    );
    expect(registry.markStoppedById).toHaveBeenCalledWith(
      expect.objectContaining({ id: "rr-2" }),
      "interrupted_by_restart"
    );
  });

  it("does not touch running sandbox rows (containers survive an API restart)", async () => {
    const registry = makeRegistry();
    const sandboxInstances = makeSandboxInstances();
    const localInstances = makeLocalInstances();
    const service = new RuntimeInstanceLifecycleService(
      registry as never,
      sandboxInstances as never,
      localInstances as never
    );

    await service.onApplicationBootstrap();

    expect(registry.findRunningByRuntimeType).toHaveBeenCalledWith("local");
    expect(registry.findRunningByRuntimeType).not.toHaveBeenCalledWith(
      "sandbox"
    );
  });

  it("logs a warning and continues when recovering one orphaned local row throws", async () => {
    const registry = makeRegistry({
      findRunningByRuntimeType: vi.fn().mockResolvedValue([
        {
          id: "rr-1",
          runtimeType: "local",
          isolationScope: "workspace",
          ownerId: "ws-1",
          runtimeInstanceId: "4242:token",
        },
        {
          id: "rr-2",
          runtimeType: "local",
          isolationScope: "workspace",
          ownerId: "ws-2",
          runtimeInstanceId: "5555:token",
        },
      ]),
    });
    const sandboxInstances = makeSandboxInstances();
    const recoverOrphan = vi
      .fn()
      .mockRejectedValueOnce(new Error("ESRCH"))
      .mockResolvedValueOnce(undefined);
    const localInstances = makeLocalInstances({ recoverOrphan });
    const service = new RuntimeInstanceLifecycleService(
      registry as never,
      sandboxInstances as never,
      localInstances as never
    );

    await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(recoverOrphan).toHaveBeenCalledTimes(2);
    expect(registry.markStoppedById).toHaveBeenCalledTimes(2);
  });
});
