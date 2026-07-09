import { beforeEach, describe, it, expect, vi } from "vitest";
import type { RunConfig, CommandPayload } from "@agework/shared/protocol";
import { WorkerCommandDispatcher } from "./connection/command-dispatcher";
import { WorkerUpstreamRegistry } from "./connection/worker-upstream.registry";
import { WorkerEndpointHandler } from "./connection/worker-endpoint.handler";
import type { WorkerUpstreamPort } from "./worker-manager.types";
import { WorkerManagerService } from "./worker-manager.service";
import type { WorkerRegistryRepository } from "./registry/worker-registry.repository";

/**
 * WorkerManagerService 是 worker-manager 唯一 export 的公开面,所有跨模块调用方
 * (run 模块)都依赖它。controller spec 直接 new WorkerEndpointHandler,因此没有
 * 任何测试穿过 facade 验证委托接线。这里 mock 全套 internal provider,固定
 * facade 把每个公开方法路由到正确的 internal provider。
 */
function makeService() {
  const endpointHandler = {
    pollCommands: vi.fn(),
    getRunConfig: vi.fn(),
    postEvent: vi.fn(),
  };
  const upstream = {
    setUpstreamPort: vi.fn(),
  };
  const commandDispatcher = {
    openSession: vi.fn(),
    sendCommand: vi.fn(),
    cleanupRun: vi.fn(),
    cleanupByWorkerId: vi.fn(),
  };
  const provisioner = {
    acquireInstanceForRun: vi.fn(),
    stop: vi.fn(),
  };
  const runtimeService = {
    resolveRuntimeSpec: vi.fn(),
  };
  const livenessStore = {
    touch: vi.fn(),
    lastSeenAt: vi.fn(),
    remove: vi.fn(),
    listStale: vi.fn(),
  };
  const ownerRunStore = {
    registerRun: vi.fn(),
    unregisterRun: vi.fn(),
    listRunIdsByWorkerId: vi.fn(),
    findWorkerIdByRunId: vi.fn(),
  };
  const service = new WorkerManagerService(
    endpointHandler as unknown as WorkerEndpointHandler,
    upstream as unknown as WorkerUpstreamRegistry,
    commandDispatcher as unknown as WorkerCommandDispatcher,
    {} as unknown as WorkerRegistryRepository,
    runtimeService as never,
    provisioner as never,
    {} as never,
    livenessStore as never,
    ownerRunStore as never
  );
  return {
    service,
    endpointHandler,
    upstream,
    commandDispatcher,
    provisioner,
    runtimeService,
    livenessStore,
    ownerRunStore,
  };
}

describe("WorkerManagerService — facade routing", () => {
  it("routes pollCommands to the endpoint handler", async () => {
    const { service, endpointHandler } = makeService();
    endpointHandler.pollCommands.mockResolvedValue({ messages: [] });

    await service.pollCommands("owner-1", { afterSeq: 3, waitMs: 0 });

    expect(endpointHandler.pollCommands).toHaveBeenCalledWith("owner-1", {
      afterSeq: 3,
      waitMs: 0,
    });
  });

  it("pollCommands touches the liveness store (long-poll doubles as heartbeat)", async () => {
    const { service, endpointHandler, livenessStore } = makeService();
    endpointHandler.pollCommands.mockResolvedValue({ messages: [] });

    await service.pollCommands("owner-1", { afterSeq: 0, waitMs: 0 });

    expect(livenessStore.touch).toHaveBeenCalledWith("owner-1");
  });

  it("routes getRunConfig to the endpoint handler", () => {
    const { service, endpointHandler } = makeService();
    const config = { runId: "run-1" } as unknown as RunConfig;
    endpointHandler.getRunConfig.mockReturnValue({ config });

    expect(service.getRunConfig("run-1")).toEqual({ config });
    expect(endpointHandler.getRunConfig).toHaveBeenCalledWith("run-1");
  });

  it("routes postEvent to the endpoint handler", async () => {
    const { service, endpointHandler } = makeService();
    endpointHandler.postEvent.mockResolvedValue({ ok: true });

    await service.postEvent("run-1", { body: true });

    expect(endpointHandler.postEvent).toHaveBeenCalledWith("run-1", {
      body: true,
    });
  });

  it("postEvent touches the liveness store for the run's owner (reporting also proves it's alive)", async () => {
    const { service, endpointHandler, livenessStore, ownerRunStore } =
      makeService();
    endpointHandler.postEvent.mockResolvedValue({ ok: true });
    ownerRunStore.findWorkerIdByRunId.mockReturnValue("worker-1");

    await service.postEvent("run-1", { body: true });

    expect(ownerRunStore.findWorkerIdByRunId).toHaveBeenCalledWith("run-1");
    expect(livenessStore.touch).toHaveBeenCalledWith("worker-1");
  });

  it("postEvent skips the liveness touch when the run has no known owner", async () => {
    const { service, endpointHandler, livenessStore, ownerRunStore } =
      makeService();
    endpointHandler.postEvent.mockResolvedValue({ ok: true });
    ownerRunStore.findWorkerIdByRunId.mockReturnValue(undefined);

    await service.postEvent("run-1", { body: true });

    expect(livenessStore.touch).not.toHaveBeenCalled();
  });

  it("routes openSession to the command dispatcher with passthrough params", () => {
    const { service, commandDispatcher } = makeService();
    const params = {
      runId: "run-1",
      workerId: "worker-1",
      runConfig: { runId: "run-1" } as unknown as RunConfig,
    };

    service.openSession(params);

    expect(commandDispatcher.openSession).toHaveBeenCalledWith(params);
  });

  it("routes sendCommand to the command dispatcher", () => {
    const { service, commandDispatcher } = makeService();
    const command = {
      type: "cancel",
      commandId: "cmd-1",
      runId: "run-1",
    } as unknown as CommandPayload;

    service.sendCommand("worker-1", "run-1", command);

    expect(commandDispatcher.sendCommand).toHaveBeenCalledWith(
      "worker-1",
      "run-1",
      command
    );
  });

  it("routes cleanupRun to the command dispatcher", () => {
    const { service, commandDispatcher } = makeService();

    service.cleanupRun("run-1");

    expect(commandDispatcher.cleanupRun).toHaveBeenCalledWith("run-1");
  });

  it("routes cleanupByWorkerId to the command dispatcher", () => {
    const { service, commandDispatcher } = makeService();

    service.cleanupByWorkerId("worker-1");

    expect(commandDispatcher.cleanupByWorkerId).toHaveBeenCalledWith("worker-1");
  });

  it("routes setUpstreamPort to the upstream registry", () => {
    const { service, upstream } = makeService();
    const receiver = {
      sendEvent: vi.fn(),
    } as unknown as WorkerUpstreamPort;

    service.setUpstreamPort(receiver);

    expect(upstream.setUpstreamPort).toHaveBeenCalledWith(receiver);
  });

  it("routes resolveRuntimeSpec to RuntimeService", () => {
    const { service, runtimeService } = makeService();
    const target = { runtimeType: "native", ownerId: "ws-1" } as never;
    runtimeService.resolveRuntimeSpec.mockReturnValue(target);

    const input = {
      userId: "user-1",
      workspaceId: "ws-1",
      workspaceRootPath: "/tmp/ws-1",
      userWorkspaceRootPath: "/tmp/user-1",
      runtimeLogHostPath: "/tmp/logs/runtime",
      runtimeType: "native" as const,
    };
    expect(service.resolveRuntimeSpec(input)).toBe(target);
    expect(runtimeService.resolveRuntimeSpec).toHaveBeenCalledWith(input);
  });
});

function makeRepositoryMock() {
  return {
    findActiveByWorkspace: vi.fn(),
    upsertRunning: vi.fn(),
    markStoppedByOwner: vi.fn(),
    markErrorByOwner: vi.fn(),
    isRuntimeInstanceBoundToWorkspace: vi.fn(),
    countRunning: vi.fn(),
    findByRuntimeId: vi.fn(),
    findRunInstanceView: vi.fn(),
    listResourcesPage: vi.fn(),
    findById: vi.fn(),
    findBindingWithResource: vi.fn(),
    findWorkspaceIdsByUser: vi.fn(),
    findRunningByOwners: vi.fn(),
    markStoppedById: vi.fn(),
    deleteWorkspaceBinding: vi.fn(),
    findActiveByWorkerId: vi.fn(),
  } as unknown as WorkerRegistryRepository;
}

describe("WorkerManagerService WorkerRegistry cross-module queries", () => {
  let repository: ReturnType<typeof makeRepositoryMock>;
  let service: WorkerManagerService;

  beforeEach(() => {
    repository = makeRepositoryMock();
    service = new WorkerManagerService(
      {} as any,
      {} as any,
      {} as any,
      repository,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any
    );
  });

  it("findRuntimeByRuntimeId forwards to repository.findByRuntimeId", async () => {
    (repository.findByRuntimeId as any).mockResolvedValue({ id: "x" });
    const result = await service.findRuntimeByRuntimeId("sandbox", "inst-1");
    expect(repository.findByRuntimeId).toHaveBeenCalledWith(
      "sandbox",
      "inst-1"
    );
    expect(result).toEqual({ id: "x" });
  });

  it("getWorkerStats counts running runtime resources", async () => {
    (repository.countRunning as any).mockResolvedValue(3);
    expect(await service.getWorkerStats()).toEqual({ activeWorkers: 3 });
  });
});

describe("WorkerManagerService runtime policy", () => {
  function makeService() {
    const runtimeService = { getRuntimePolicy: vi.fn() };
    const service = new WorkerManagerService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      runtimeService as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never
    );
    return { service, runtimeService };
  }

  it("getRuntimePolicy forwards to RuntimeService", () => {
    const { service, runtimeService } = makeService();
    runtimeService.getRuntimePolicy.mockReturnValue({ runtimeType: "native" });
    expect(service.getRuntimePolicy()).toEqual({ runtimeType: "native" });
  });
});

describe("WorkerManagerService.stopWorkerInstance", () => {
  function makeService() {
    const registry = {
      findById: vi.fn(),
      markStoppedById: vi.fn().mockResolvedValue(undefined),
    };
    const provisioner = { stop: vi.fn().mockResolvedValue(undefined) };
    const service = new WorkerManagerService(
      {} as never,
      {} as never,
      {} as never,
      registry as never,
      {} as never,
      provisioner as never,
      {} as never,
      {} as never,
      {} as never
    );
    return { service, registry, provisioner };
  }

  it("tears down the sandbox resource through the provisioner using a ref built from the DB row", async () => {
    const { service, registry, provisioner } = makeService();
    registry.findById.mockResolvedValue({
      id: "rr-1",
      runtimeType: "docker",
      ownerId: "ws-1",
      instanceId: "container-1",
      isolationScope: "workspace",
      runtimeId: "managed-docker",
      status: "running",
    });

    await expect(service.stopWorkerInstance("rr-1")).resolves.toEqual({
      ok: true,
    });

    expect(provisioner.stop).toHaveBeenCalledWith({
      runtimeType: "docker",
      ownerId: "ws-1",
      workerId: "rr-1",
      runtimeInstanceId: "container-1",
      isolationScope: "workspace",
      targetRuntimeId: "managed-docker",
    });
    expect(registry.markStoppedById).toHaveBeenCalledWith(
      expect.objectContaining({ id: "rr-1" }),
      "manual_stop"
    );
  });

  it("tears down the local resource through the provisioner using a ref built from the DB row", async () => {
    const { service, registry, provisioner } = makeService();
    registry.findById.mockResolvedValue({
      id: "rr-2",
      runtimeType: "native",
      ownerId: "ws-2",
      instanceId: "4242:token",
      isolationScope: "workspace",
      runtimeId: "managed-native",
      status: "running",
    });

    await expect(service.stopWorkerInstance("rr-2")).resolves.toEqual({
      ok: true,
    });

    expect(provisioner.stop).toHaveBeenCalledWith({
      runtimeType: "native",
      ownerId: "ws-2",
      workerId: "rr-2",
      runtimeInstanceId: "4242:token",
      isolationScope: "workspace",
      targetRuntimeId: "managed-native",
    });
    expect(registry.markStoppedById).toHaveBeenCalledWith(
      expect.objectContaining({ id: "rr-2" }),
      "manual_stop"
    );
  });

  it("throws when the resource is missing or not running", async () => {
    const { service, registry, provisioner } = makeService();
    registry.findById.mockResolvedValue({ status: "stopped" });

    await expect(service.stopWorkerInstance("rr-3")).rejects.toThrow(
      "not found or not running"
    );
    expect(registry.markStoppedById).not.toHaveBeenCalled();
    expect(provisioner.stop).not.toHaveBeenCalled();
  });
});

describe("WorkerManagerService — resolveInstance/releaseInstanceForRun", () => {
  function makeService() {
    const provisioner = {
      acquireInstanceForRun: vi.fn(),
      stop: vi.fn(),
    };
    const ownerRunStore = {
      registerRun: vi.fn(),
      unregisterRun: vi.fn(),
      listRunIdsByWorkerId: vi.fn(),
    };
    const service = new WorkerManagerService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      provisioner as never,
      {} as never,
      {} as never,
      ownerRunStore as never
    );
    return { service, provisioner, ownerRunStore };
  }

  it("resolveInstance forwards local placements to the provisioner and registers the run in the owner index", async () => {
    const { service, provisioner, ownerRunStore } = makeService();
    const input = {
      runtimeTarget: { runtimeType: "native", ownerId: "ws-1" },
      runConfig: { runId: "run-1" },
    } as never;
    provisioner.acquireInstanceForRun.mockResolvedValue({
      outcome: "ready",
      workerId: "worker-1",
      runtimeInstanceId: "1:token",
    });

    await expect(service.resolveInstance(input)).resolves.toEqual({
      outcome: "ready",
      workerId: "worker-1",
      runtimeInstanceId: "1:token",
    });
    expect(provisioner.acquireInstanceForRun).toHaveBeenCalledWith(input);
    expect(ownerRunStore.registerRun).toHaveBeenCalledWith("run-1", "worker-1");
  });

  it("resolveInstance forwards sandbox placements to the provisioner and registers the run in the owner index", async () => {
    const { service, provisioner, ownerRunStore } = makeService();
    const input = {
      runtimeTarget: { runtimeType: "docker", ownerId: "ws-2" },
      runConfig: { runId: "run-2" },
    } as never;
    provisioner.acquireInstanceForRun.mockResolvedValue({
      outcome: "ready",
      workerId: "worker-2",
      runtimeInstanceId: "container-1",
    });

    await expect(service.resolveInstance(input)).resolves.toEqual({
      outcome: "ready",
      workerId: "worker-2",
      runtimeInstanceId: "container-1",
    });
    expect(provisioner.acquireInstanceForRun).toHaveBeenCalledWith(input);
    expect(ownerRunStore.registerRun).toHaveBeenCalledWith("run-2", "worker-2");
  });

  it("releaseInstanceForRun only clears the owner index (no reclaim/instance-side action)", () => {
    const { service, provisioner, ownerRunStore } = makeService();
    service.releaseInstanceForRun("run-1");
    expect(ownerRunStore.unregisterRun).toHaveBeenCalledWith("run-1");
    expect(provisioner.acquireInstanceForRun).not.toHaveBeenCalled();
    expect(provisioner.stop).not.toHaveBeenCalled();
  });
});

describe("WorkerManagerService.registerWorker", () => {
  function makeService() {
    const handshakeStore = { registerWorker: vi.fn() };
    const service = new WorkerManagerService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      handshakeStore as never,
      {} as never,
      {} as never
    );
    return { service, handshakeStore };
  }

  it("returns ok:true when the handshake store accepts the token", async () => {
    const { service, handshakeStore } = makeService();
    handshakeStore.registerWorker.mockReturnValue(true);

    await expect(
      service.registerWorker("worker-1", { startToken: "token-1", pid: 4242 })
    ).resolves.toEqual({ ok: true });
    expect(handshakeStore.registerWorker).toHaveBeenCalledWith(
      "worker-1",
      "token-1",
      { pid: 4242 }
    );
  });

  it("throws BadRequestException when the handshake store rejects the token", async () => {
    const { service, handshakeStore } = makeService();
    handshakeStore.registerWorker.mockReturnValue(false);

    await expect(
      service.registerWorker("worker-1", { startToken: "wrong-token" })
    ).rejects.toThrow(/no pending launch handshake/);
  });
});
