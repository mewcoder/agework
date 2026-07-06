import { describe, it, expect, vi } from "vitest";
import { WorkerLifecycleHandler } from "./lifecycle.handler";

function makeResource(overrides: Record<string, unknown> = {}) {
  return {
    id: "rr-1",
    runtimeType: "docker",
    isolationScope: "workspace",
    ownerId: "ws-1",
    instanceId: "container-1",
    runtimeId: "rt-1",
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
    stop: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeRuntimeService(overrides: Record<string, unknown> = {}) {
  const runtime = {
    destroy: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  return {
    ...runtime,
    runtimeFor: vi.fn().mockReturnValue(runtime),
    getBuiltinRuntimeId: vi.fn().mockReturnValue("builtin-local"),
  };
}

function makeLivenessStore(overrides: Record<string, unknown> = {}) {
  return {
    touch: vi.fn(),
    ...overrides,
  };
}

describe("WorkerLifecycleHandler", () => {
  describe("shutdownForWorkspace", () => {
    it("shuts down a workspace-owned sandbox resource through the provisioner and deletes the workspace binding", async () => {
      const registry = makeRegistry({
        findBindingWithResource: vi.fn().mockResolvedValue({
          id: "wr-1",
          workspaceId: "ws-1",
          worker: makeResource(),
        }),
      });
      const provisioner = makeProvisioner();
      const runtimeService = makeRuntimeService();
      const livenessStore = makeLivenessStore();
      const service = new WorkerLifecycleHandler(
        registry as never,
        provisioner as never,
        runtimeService as never,
        livenessStore as never
      );

      await service.shutdownForWorkspace("ws-1");

      expect(registry.findBindingWithResource).toHaveBeenCalledWith("ws-1");
      expect(provisioner.destroy).toHaveBeenCalledWith({
        runtimeType: "docker",
        ownerId: "ws-1",
        runtimeInstanceId: "container-1",
        isolationScope: "workspace",
        targetRuntimeId: "rt-1",
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
          worker: makeResource({
            isolationScope: "user",
            ownerId: "user-1",
          }),
        }),
      });
      const provisioner = makeProvisioner();
      const runtimeService = makeRuntimeService();
      const livenessStore = makeLivenessStore();
      const service = new WorkerLifecycleHandler(
        registry as never,
        provisioner as never,
        runtimeService as never,
        livenessStore as never
      );

      await service.shutdownForWorkspace("ws-1");

      expect(provisioner.destroy).not.toHaveBeenCalled();
      expect(registry.markStoppedById).not.toHaveBeenCalled();
      expect(registry.deleteWorkspaceBinding).toHaveBeenCalledWith("ws-1");
    });

    it("shuts down a workspace-owned local resource through the provisioner", async () => {
      const registry = makeRegistry({
        findBindingWithResource: vi.fn().mockResolvedValue({
          id: "wr-1",
          workspaceId: "ws-1",
          worker: makeResource({
            runtimeType: "local",
            instanceId: "4242:token",
          }),
        }),
      });
      const provisioner = makeProvisioner();
      const runtimeService = makeRuntimeService();
      const livenessStore = makeLivenessStore();
      const service = new WorkerLifecycleHandler(
        registry as never,
        provisioner as never,
        runtimeService as never,
        livenessStore as never
      );

      await service.shutdownForWorkspace("ws-1");

      expect(provisioner.destroy).toHaveBeenCalledWith({
        runtimeType: "local",
        ownerId: "ws-1",
        runtimeInstanceId: "4242:token",
        isolationScope: "workspace",
        targetRuntimeId: "rt-1",
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
            instanceId: "container-user",
          }),
          makeResource({
            id: "rr-ws",
            ownerId: "ws-2",
            instanceId: "container-ws",
          }),
        ]),
      });
      const provisioner = makeProvisioner();
      const runtimeService = makeRuntimeService();
      const livenessStore = makeLivenessStore();
      const service = new WorkerLifecycleHandler(
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
      expect(provisioner.destroy).toHaveBeenCalledWith(
        expect.objectContaining({ ownerId: "user-1" })
      );
      expect(provisioner.destroy).toHaveBeenCalledWith(
        expect.objectContaining({ ownerId: "ws-2" })
      );
      expect(provisioner.destroy).toHaveBeenCalledTimes(2);
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
    const destroy = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("boom");
      })
      .mockImplementationOnce(() => Promise.resolve());
    const provisioner = makeProvisioner({ destroy });
    const runtimeService = makeRuntimeService();
    const livenessStore = makeLivenessStore();
    const service = new WorkerLifecycleHandler(
      registry as never,
      provisioner as never,
      runtimeService as never,
      livenessStore as never
    );

    await expect(service.shutdownForUser("user-1")).resolves.toBeUndefined();
    expect(destroy).toHaveBeenCalledTimes(2);
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
          instanceId: "4242:token",
          runtimeId: "builtin-local",
        },
        {
          id: "rr-2",
          runtimeType: "local",
          isolationScope: "workspace",
          ownerId: "ws-2",
          instanceId: "5555:token",
          runtimeId: "builtin-local",
        },
      ]),
    });
    const provisioner = makeProvisioner();
    const runtimeService = makeRuntimeService();
    const livenessStore = makeLivenessStore();
    const service = new WorkerLifecycleHandler(
      registry as never,
      provisioner as never,
      runtimeService as never,
      livenessStore as never
    );

    await service.onApplicationBootstrap();

    expect(registry.markAllStartingAsError).toHaveBeenCalledTimes(1);
    expect(registry.findRunningByRuntimeType).toHaveBeenCalledWith("local");
    expect(runtimeService.destroy).toHaveBeenCalledWith({
      runtimeType: "local",
      ownerId: "ws-1",
      runtimeInstanceId: "4242:token",
      isolationScope: "workspace",
    });
    expect(runtimeService.destroy).toHaveBeenCalledWith({
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

  it("skips Registered-local rows (runtimeId set) — their parent is the remote manager, not this API process", async () => {
    const registry = makeRegistry({
      findRunningByRuntimeType: vi.fn().mockResolvedValue([
        {
          id: "rr-managed",
          runtimeType: "local",
          isolationScope: "workspace",
          ownerId: "ws-1",
          instanceId: "4242:token",
          runtimeId: "builtin-local",
        },
        {
          id: "rr-registered",
          runtimeType: "local",
          isolationScope: "workspace",
          ownerId: "ws-2",
          instanceId: "9999:token",
          runtimeId: "rt-1",
        },
      ]),
    });
    const provisioner = makeProvisioner();
    const runtimeService = makeRuntimeService();
    const livenessStore = makeLivenessStore();
    const service = new WorkerLifecycleHandler(
      registry as never,
      provisioner as never,
      runtimeService as never,
      livenessStore as never
    );

    await service.onApplicationBootstrap();

    expect(runtimeService.destroy).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: "ws-1" })
    );
    expect(runtimeService.destroy).not.toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: "ws-2" })
    );
    expect(registry.markStoppedById).toHaveBeenCalledWith(
      expect.objectContaining({ id: "rr-managed" }),
      "interrupted_by_restart"
    );
    expect(registry.markStoppedById).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: "rr-registered" }),
      expect.anything()
    );
  });

  it("does not physically clean up running sandbox rows (containers survive an API restart)", async () => {
    const registry = makeRegistry();
    const provisioner = makeProvisioner();
    const runtimeService = makeRuntimeService();
    const livenessStore = makeLivenessStore();
    const service = new WorkerLifecycleHandler(
      registry as never,
      provisioner as never,
      runtimeService as never,
      livenessStore as never
    );

    await service.onApplicationBootstrap();

    expect(registry.findRunningByRuntimeType).toHaveBeenCalledWith("local");
    expect(provisioner.destroy).not.toHaveBeenCalled();
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
    const service = new WorkerLifecycleHandler(
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
    expect(provisioner.destroy).not.toHaveBeenCalled();
  });

  it("logs a warning and continues when recovering one orphaned local row throws", async () => {
    const registry = makeRegistry({
      findRunningByRuntimeType: vi.fn().mockResolvedValue([
        {
          id: "rr-1",
          runtimeType: "local",
          isolationScope: "workspace",
          ownerId: "ws-1",
          instanceId: "4242:token",
          runtimeId: "builtin-local",
        },
        {
          id: "rr-2",
          runtimeType: "local",
          isolationScope: "workspace",
          ownerId: "ws-2",
          instanceId: "5555:token",
          runtimeId: "builtin-local",
        },
      ]),
    });
    const provisioner = makeProvisioner();
    const destroy = vi
      .fn()
      .mockRejectedValueOnce(new Error("ESRCH"))
      .mockResolvedValueOnce(undefined);
    const runtimeService = makeRuntimeService({ destroy });
    const livenessStore = makeLivenessStore();
    const service = new WorkerLifecycleHandler(
      registry as never,
      provisioner as never,
      runtimeService as never,
      livenessStore as never
    );

    await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(destroy).toHaveBeenCalledTimes(2);
    expect(registry.markStoppedById).toHaveBeenCalledTimes(2);
  });
});
