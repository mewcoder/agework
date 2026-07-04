import { describe, it, expect, vi } from "vitest";
import { WorkerInstanceLifecycleHandler } from "./lifecycle.handler";

function makeResource(overrides: Record<string, unknown> = {}) {
  return {
    id: "rr-1",
    runtimeType: "sandbox",
    isolationScope: "workspace",
    ownerId: "ws-1",
    runtimeInstanceId: "container-1",
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
    findRunningContainerRows: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function makeProvisioner(overrides: Record<string, unknown> = {}) {
  return {
    teardown: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeRuntimeService(overrides: Record<string, unknown> = {}) {
  return {
    recoverOrphan: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeLivenessStore(overrides: Record<string, unknown> = {}) {
  return {
    touch: vi.fn(),
    ...overrides,
  };
}

describe("WorkerInstanceLifecycleHandler", () => {
  describe("shutdownForWorkspace", () => {
    it("shuts down a workspace-owned sandbox resource through the provisioner and deletes the workspace binding", async () => {
      const registry = makeRegistry({
        findBindingWithResource: vi.fn().mockResolvedValue({
          id: "wr-1",
          workspaceId: "ws-1",
          workerInstance: makeResource(),
        }),
      });
      const provisioner = makeProvisioner();
      const runtimeService = makeRuntimeService();
      const livenessStore = makeLivenessStore();
      const service = new WorkerInstanceLifecycleHandler(
        registry as never,
        provisioner as never,
        runtimeService as never,
        livenessStore as never
      );

      await service.shutdownForWorkspace("ws-1");

      expect(registry.findBindingWithResource).toHaveBeenCalledWith("ws-1");
      expect(provisioner.teardown).toHaveBeenCalledWith({
        runtimeType: "sandbox",
        ownerId: "ws-1",
        runtimeInstanceId: "container-1",
        isolationScope: "workspace",
      });
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
      const provisioner = makeProvisioner();
      const runtimeService = makeRuntimeService();
      const livenessStore = makeLivenessStore();
      const service = new WorkerInstanceLifecycleHandler(
        registry as never,
        provisioner as never,
        runtimeService as never,
        livenessStore as never
      );

      await service.shutdownForWorkspace("ws-1");

      expect(provisioner.teardown).not.toHaveBeenCalled();
      expect(registry.markStoppedById).not.toHaveBeenCalled();
      expect(registry.deleteWorkspaceBinding).toHaveBeenCalledWith("ws-1");
    });

    it("shuts down a workspace-owned local resource through the provisioner", async () => {
      const registry = makeRegistry({
        findBindingWithResource: vi.fn().mockResolvedValue({
          id: "wr-1",
          workspaceId: "ws-1",
          workerInstance: makeResource({
            runtimeType: "local",
            runtimeInstanceId: "4242:token",
          }),
        }),
      });
      const provisioner = makeProvisioner();
      const runtimeService = makeRuntimeService();
      const livenessStore = makeLivenessStore();
      const service = new WorkerInstanceLifecycleHandler(
        registry as never,
        provisioner as never,
        runtimeService as never,
        livenessStore as never
      );

      await service.shutdownForWorkspace("ws-1");

      expect(provisioner.teardown).toHaveBeenCalledWith({
        runtimeType: "local",
        ownerId: "ws-1",
        runtimeInstanceId: "4242:token",
        isolationScope: "workspace",
      });
      expect(registry.markStoppedById).toHaveBeenCalledWith(
        expect.objectContaining({ id: "rr-1", runtimeType: "local" }),
        "owner_released"
      );
      expect(registry.deleteWorkspaceBinding).toHaveBeenCalledWith("ws-1");
    });
  });

  describe("shutdownForUser", () => {
    it("shuts down all resources owned by the user (user-scope + workspace-scope) through the provisioner", async () => {
      const registry = makeRegistry({
        findWorkspaceIdsByUser: vi.fn().mockResolvedValue([{ id: "ws-2" }]),
        findRunningByOwners: vi.fn().mockResolvedValue([
          makeResource({
            id: "rr-user",
            isolationScope: "user",
            ownerId: "user-1",
            runtimeInstanceId: "container-user",
          }),
          makeResource({
            id: "rr-ws",
            ownerId: "ws-2",
            runtimeInstanceId: "container-ws",
          }),
        ]),
      });
      const provisioner = makeProvisioner();
      const runtimeService = makeRuntimeService();
      const livenessStore = makeLivenessStore();
      const service = new WorkerInstanceLifecycleHandler(
        registry as never,
        provisioner as never,
        runtimeService as never,
        livenessStore as never
      );

      await service.shutdownForUser("user-1");

      expect(registry.findWorkspaceIdsByUser).toHaveBeenCalledWith("user-1");
      expect(registry.findRunningByOwners).toHaveBeenCalledWith([
        "user-1",
        "ws-2",
      ]);
      expect(provisioner.teardown).toHaveBeenCalledWith(
        expect.objectContaining({ ownerId: "user-1" })
      );
      expect(provisioner.teardown).toHaveBeenCalledWith(
        expect.objectContaining({ ownerId: "ws-2" })
      );
      expect(provisioner.teardown).toHaveBeenCalledTimes(2);
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

  it("logs a warning and continues when the provisioner throws", async () => {
    const registry = makeRegistry({
      findRunningByOwners: vi
        .fn()
        .mockResolvedValue([
          makeResource({ id: "rr-1", ownerId: "ws-1" }),
          makeResource({ id: "rr-2", ownerId: "ws-2" }),
        ]),
    });
    const teardown = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("boom");
      })
      .mockImplementationOnce(() => Promise.resolve());
    const provisioner = makeProvisioner({ teardown });
    const runtimeService = makeRuntimeService();
    const livenessStore = makeLivenessStore();
    const service = new WorkerInstanceLifecycleHandler(
      registry as never,
      provisioner as never,
      runtimeService as never,
      livenessStore as never
    );

    await expect(service.shutdownForUser("user-1")).resolves.toBeUndefined();
    expect(teardown).toHaveBeenCalledTimes(2);
  });
});

describe("onApplicationBootstrap", () => {
  it("marks all starting rows as error, then recovers orphaned local rows via RuntimeService", async () => {
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
    const provisioner = makeProvisioner();
    const runtimeService = makeRuntimeService();
    const livenessStore = makeLivenessStore();
    const service = new WorkerInstanceLifecycleHandler(
      registry as never,
      provisioner as never,
      runtimeService as never,
      livenessStore as never
    );

    await service.onApplicationBootstrap();

    expect(registry.markAllStartingAsError).toHaveBeenCalledTimes(1);
    expect(registry.findRunningByRuntimeType).toHaveBeenCalledWith("local");
    expect(runtimeService.recoverOrphan).toHaveBeenCalledWith({
      runtimeType: "local",
      ownerId: "ws-1",
      runtimeInstanceId: "4242:token",
      isolationScope: "workspace",
    });
    expect(runtimeService.recoverOrphan).toHaveBeenCalledWith({
      runtimeType: "local",
      ownerId: "ws-2",
      runtimeInstanceId: "5555:token",
      isolationScope: "workspace",
    });
    expect(registry.markStoppedById).toHaveBeenCalledWith(
      expect.objectContaining({ id: "rr-1" }),
      "interrupted_by_restart"
    );
    expect(registry.markStoppedById).toHaveBeenCalledWith(
      expect.objectContaining({ id: "rr-2" }),
      "interrupted_by_restart"
    );
  });

  it("does not physically clean up running sandbox rows (containers survive an API restart)", async () => {
    const registry = makeRegistry();
    const provisioner = makeProvisioner();
    const runtimeService = makeRuntimeService();
    const livenessStore = makeLivenessStore();
    const service = new WorkerInstanceLifecycleHandler(
      registry as never,
      provisioner as never,
      runtimeService as never,
      livenessStore as never
    );

    await service.onApplicationBootstrap();

    expect(registry.findRunningByRuntimeType).toHaveBeenCalledWith("local");
    expect(provisioner.teardown).not.toHaveBeenCalled();
    expect(registry.markStoppedById).not.toHaveBeenCalled();
  });

  it("touches WorkerLivenessStore for every running container row so a dead owner eventually enters listStale", async () => {
    const registry = makeRegistry({
      findRunningContainerRows: vi.fn().mockResolvedValue([
        makeResource({
          id: "rr-sb-1",
          runtimeType: "docker",
          ownerId: "ws-sb-1",
        }),
        makeResource({
          id: "rr-sb-2",
          runtimeType: "opensandbox",
          ownerId: "ws-sb-2",
        }),
      ]),
    });
    const provisioner = makeProvisioner();
    const runtimeService = makeRuntimeService();
    const livenessStore = makeLivenessStore();
    const service = new WorkerInstanceLifecycleHandler(
      registry as never,
      provisioner as never,
      runtimeService as never,
      livenessStore as never
    );

    await service.onApplicationBootstrap();

    expect(registry.findRunningContainerRows).toHaveBeenCalledTimes(1);
    expect(livenessStore.touch).toHaveBeenCalledWith("ws-sb-1");
    expect(livenessStore.touch).toHaveBeenCalledWith("ws-sb-2");
    expect(livenessStore.touch).toHaveBeenCalledTimes(2);
    expect(provisioner.teardown).not.toHaveBeenCalled();
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
    const provisioner = makeProvisioner();
    const recoverOrphan = vi
      .fn()
      .mockRejectedValueOnce(new Error("ESRCH"))
      .mockResolvedValueOnce(undefined);
    const runtimeService = makeRuntimeService({ recoverOrphan });
    const livenessStore = makeLivenessStore();
    const service = new WorkerInstanceLifecycleHandler(
      registry as never,
      provisioner as never,
      runtimeService as never,
      livenessStore as never
    );

    await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(recoverOrphan).toHaveBeenCalledTimes(2);
    expect(registry.markStoppedById).toHaveBeenCalledTimes(2);
  });
});
