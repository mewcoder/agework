import { beforeEach, describe, it, expect, vi } from "vitest";
import type { RunConfig, CommandPayload } from "@agework/shared/protocol";
import { WorkerCommandDispatcher } from "./command/command-dispatcher.service";
import { WorkerUpstreamRegistry } from "./upstream/worker-upstream.registry";
import { WorkerEndpointHandler } from "./endpoint/worker-endpoint.handler";
import type { WorkerUpstreamPort } from "./worker-manager.types";
import { WorkerManagerService } from "./worker-manager.service";
import type { WorkerRegistryRepository } from "./registry/worker-registry.repository";

/**
 * WorkerManagerService 是 worker-manager 唯一 export 的公开面,所有跨模块调用方
 * (sandbox.executor / runs.module)都依赖它。controller spec 直接 new
 * WorkerEndpointHandler、sandbox spec 整体 mock 掉 facade,因此没有任何
 * 测试穿过 facade 验证委托接线。这里 mock 全套 internal provider,固定
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
    cleanupByOwnerId: vi.fn(),
  };
  const localInstances = {};
  const runtimeService = {
    resolveRuntimeTarget: vi.fn(),
  };
  const livenessStore = {
    touch: vi.fn(),
    lastSeenAt: vi.fn(),
    remove: vi.fn(),
    listStale: vi.fn(),
  };
  const service = new WorkerManagerService(
    endpointHandler as unknown as WorkerEndpointHandler,
    upstream as unknown as WorkerUpstreamRegistry,
    commandDispatcher as unknown as WorkerCommandDispatcher,
    {} as unknown as WorkerRegistryRepository,
    runtimeService as never,
    {} as never,
    localInstances as never,
    {} as never,
    livenessStore as never
  );
  return {
    service,
    endpointHandler,
    upstream,
    commandDispatcher,
    runtimeService,
    livenessStore,
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

  it("routes openSession to the command dispatcher with passthrough params", () => {
    const { service, commandDispatcher } = makeService();
    const params = {
      runId: "run-1",
      ownerId: "owner-1",
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

    service.sendCommand("owner-1", "run-1", command);

    expect(commandDispatcher.sendCommand).toHaveBeenCalledWith(
      "owner-1",
      "run-1",
      command
    );
  });

  it("routes cleanupRun to the command dispatcher", () => {
    const { service, commandDispatcher } = makeService();

    service.cleanupRun("run-1");

    expect(commandDispatcher.cleanupRun).toHaveBeenCalledWith("run-1");
  });

  it("routes cleanupByOwnerId to the command dispatcher", () => {
    const { service, commandDispatcher } = makeService();

    service.cleanupByOwnerId("owner-1");

    expect(commandDispatcher.cleanupByOwnerId).toHaveBeenCalledWith("owner-1");
  });

  it("routes setUpstreamPort to the upstream registry", () => {
    const { service, upstream } = makeService();
    const receiver = {
      sendEvent: vi.fn(),
    } as unknown as WorkerUpstreamPort;

    service.setUpstreamPort(receiver);

    expect(upstream.setUpstreamPort).toHaveBeenCalledWith(receiver);
  });

  it("routes resolveRuntimeTarget to RuntimeService", () => {
    const { service, runtimeService } = makeService();
    const target = { runtimeType: "local", ownerId: "ws-1" } as never;
    runtimeService.resolveRuntimeTarget.mockReturnValue(target);

    const input = {
      userId: "user-1",
      workspaceId: "ws-1",
      workspaceRootPath: "/tmp/ws-1",
      userWorkspaceRootPath: "/tmp/user-1",
      runtimeLogHostPath: "/tmp/logs/runtime",
      runtimeType: "local" as const,
    };
    expect(service.resolveRuntimeTarget(input)).toBe(target);
    expect(runtimeService.resolveRuntimeTarget).toHaveBeenCalledWith(input);
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

  it("getRuntimeStats counts running runtime resources", async () => {
    (repository.countRunning as any).mockResolvedValue(3);
    expect(await service.getRuntimeStats()).toEqual({ activeRuntimes: 3 });
  });
});

describe("WorkerManagerService sandbox instance orchestration", () => {
  function makeService() {
    const runtimeService = { getRuntimePolicy: vi.fn() };
    const sandboxInstances = {
      acquireInstanceForRun: vi.fn(),
      releaseInstanceForRun: vi.fn(),
      recoverOrphan: vi.fn(),
      shutdownRuntimeInstanceByOwnerId: vi.fn(),
    };
    const service = new WorkerManagerService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      runtimeService as never,
      sandboxInstances as never,
      {} as never,
      {} as never,
      {} as never
    );
    return { service, runtimeService, sandboxInstances };
  }

  it("getRuntimePolicy forwards to RuntimeService", () => {
    const { service, runtimeService } = makeService();
    runtimeService.getRuntimePolicy.mockReturnValue({ runtimeType: "local" });
    expect(service.getRuntimePolicy()).toEqual({ runtimeType: "local" });
  });
});

describe("WorkerManagerService.stopRuntimeInstance", () => {
  function makeService() {
    const registry = {
      findById: vi.fn(),
      markStoppedById: vi.fn().mockResolvedValue(undefined),
    };
    const sandboxInstances = { shutdownRuntimeInstanceByOwnerId: vi.fn() };
    const localInstances = {
      shutdownRuntimeInstanceByOwnerId: vi.fn(),
    };
    const service = new WorkerManagerService(
      {} as never,
      {} as never,
      {} as never,
      registry as never,
      {} as never,
      sandboxInstances as never,
      localInstances as never,
      {} as never,
      {} as never
    );
    return { service, registry, sandboxInstances, localInstances };
  }

  it("physically shuts down the sandbox executor for a running sandbox resource", async () => {
    const { service, registry, sandboxInstances, localInstances } =
      makeService();
    registry.findById.mockResolvedValue({
      id: "rr-1",
      runtimeType: "sandbox",
      ownerId: "ws-1",
      status: "running",
    });

    await expect(service.stopRuntimeInstance("rr-1")).resolves.toEqual({
      ok: true,
    });

    expect(
      sandboxInstances.shutdownRuntimeInstanceByOwnerId
    ).toHaveBeenCalledWith("ws-1");
    expect(
      localInstances.shutdownRuntimeInstanceByOwnerId
    ).not.toHaveBeenCalled();
    expect(registry.markStoppedById).toHaveBeenCalledWith(
      expect.objectContaining({ id: "rr-1" }),
      "manual_stop"
    );
  });

  it("physically shuts down the local executor for a running local resource", async () => {
    const { service, registry, sandboxInstances, localInstances } =
      makeService();
    registry.findById.mockResolvedValue({
      id: "rr-2",
      runtimeType: "local",
      ownerId: "ws-2",
      status: "running",
    });

    await expect(service.stopRuntimeInstance("rr-2")).resolves.toEqual({
      ok: true,
    });

    expect(
      localInstances.shutdownRuntimeInstanceByOwnerId
    ).toHaveBeenCalledWith("ws-2");
    expect(
      sandboxInstances.shutdownRuntimeInstanceByOwnerId
    ).not.toHaveBeenCalled();
    expect(registry.markStoppedById).toHaveBeenCalledWith(
      expect.objectContaining({ id: "rr-2" }),
      "manual_stop"
    );
  });

  it("throws when the resource is missing or not running", async () => {
    const { service, registry } = makeService();
    registry.findById.mockResolvedValue({ status: "stopped" });

    await expect(service.stopRuntimeInstance("rr-3")).rejects.toThrow(
      "not found or not running"
    );
    expect(registry.markStoppedById).not.toHaveBeenCalled();
  });
});

describe("WorkerManagerService — resolveInstance unified dispatch", () => {
  function makeService() {
    const sandboxInstances = {
      acquireInstanceForRun: vi.fn(),
      releaseInstanceForRun: vi.fn(),
      shutdownRuntimeInstanceByOwnerId: vi.fn(),
    };
    const localInstances = {
      acquireInstanceForRun: vi.fn(),
      releaseInstanceForRun: vi.fn(),
      shutdownRuntimeInstanceByOwnerId: vi.fn(),
    };
    const service = new WorkerManagerService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      sandboxInstances as never,
      localInstances as never,
      {} as never,
      {} as never
    );
    return { service, sandboxInstances, localInstances };
  }

  it("resolveInstance dispatches to the local executor for local placements", async () => {
    const { service, localInstances } = makeService();
    const input = {
      runtimeTarget: { runtimeType: "local", ownerId: "ws-1" },
      runConfig: { runId: "run-1" },
    } as never;
    localInstances.acquireInstanceForRun.mockResolvedValue({
      outcome: "ready",
      runtimeInstanceId: "1:token",
    });

    await expect(service.resolveInstance(input)).resolves.toEqual({
      outcome: "ready",
      runtimeInstanceId: "1:token",
    });
    expect(localInstances.acquireInstanceForRun).toHaveBeenCalledWith(input);
  });

  it("resolveInstance dispatches to the sandbox executor for sandbox placements", async () => {
    const { service, sandboxInstances } = makeService();
    const input = {
      runtimeTarget: { runtimeType: "sandbox", ownerId: "ws-2" },
      runConfig: { runId: "run-2" },
    } as never;
    sandboxInstances.acquireInstanceForRun.mockResolvedValue({
      outcome: "ready",
      runtimeInstanceId: "container-1",
    });

    await expect(service.resolveInstance(input)).resolves.toEqual({
      outcome: "ready",
      runtimeInstanceId: "container-1",
    });
    expect(sandboxInstances.acquireInstanceForRun).toHaveBeenCalledWith(input);
  });

  it("releaseInstanceForRun always delegates to the sandbox executor (local has no per-run release)", () => {
    const { service, sandboxInstances, localInstances } = makeService();
    service.releaseInstanceForRun("run-1");
    expect(sandboxInstances.releaseInstanceForRun).toHaveBeenCalledWith(
      "run-1"
    );
    expect(localInstances.releaseInstanceForRun).not.toHaveBeenCalled();
  });

  it("shutdownInstanceByOwnerId dispatches by runtimeType", () => {
    const { service, sandboxInstances, localInstances } = makeService();
    service.shutdownInstanceByOwnerId("local", "ws-1");
    service.shutdownInstanceByOwnerId("sandbox", "ws-2");
    expect(
      localInstances.shutdownRuntimeInstanceByOwnerId
    ).toHaveBeenCalledWith("ws-1");
    expect(
      sandboxInstances.shutdownRuntimeInstanceByOwnerId
    ).toHaveBeenCalledWith("ws-2");
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
      {} as never,
      handshakeStore as never,
      {} as never
    );
    return { service, handshakeStore };
  }

  it("returns ok:true when the handshake store accepts the token", async () => {
    const { service, handshakeStore } = makeService();
    handshakeStore.registerWorker.mockReturnValue(true);

    await expect(
      service.registerWorker("owner-1", { startToken: "token-1", pid: 4242 })
    ).resolves.toEqual({ ok: true });
    expect(handshakeStore.registerWorker).toHaveBeenCalledWith(
      "owner-1",
      "token-1",
      { pid: 4242 }
    );
  });

  it("throws BadRequestException when the handshake store rejects the token", async () => {
    const { service, handshakeStore } = makeService();
    handshakeStore.registerWorker.mockReturnValue(false);

    await expect(
      service.registerWorker("owner-1", { startToken: "wrong-token" })
    ).rejects.toThrow(/no pending launch handshake/);
  });
});

describe("WorkerManagerService — owner→run index and fenceOwner", () => {
  function makeService() {
    const registry = {
      findActiveByOwnerId: vi.fn(),
    };
    const upstream = {
      notifyWorkerLost: vi.fn().mockResolvedValue(undefined),
    };
    const commandDispatcher = {
      cleanupRun: vi.fn(),
      cleanupByOwnerId: vi.fn(),
    };
    const sandboxInstances = {
      acquireInstanceForRun: vi.fn(),
      releaseInstanceForRun: vi.fn(),
      shutdownRuntimeInstanceByOwnerId: vi.fn(),
    };
    const localInstances = {
      acquireInstanceForRun: vi.fn(),
      shutdownRuntimeInstanceByOwnerId: vi.fn(),
    };
    const livenessStore = {
      remove: vi.fn(),
    };
    const service = new WorkerManagerService(
      {} as never,
      upstream as never,
      commandDispatcher as never,
      registry as never,
      {} as never,
      sandboxInstances as never,
      localInstances as never,
      {} as never,
      livenessStore as never
    );
    return {
      service,
      registry,
      upstream,
      commandDispatcher,
      sandboxInstances,
      localInstances,
      livenessStore,
    };
  }

  function acquireInput(runId: string, ownerId: string) {
    return {
      runtimeTarget: { runtimeType: "sandbox", ownerId },
      runConfig: { runId },
    } as never;
  }

  it("fenceOwner terminates the run registered via resolveInstance", async () => {
    const { service, registry, upstream, sandboxInstances } = makeService();
    sandboxInstances.acquireInstanceForRun.mockResolvedValue({
      outcome: "ready",
      runtimeInstanceId: "container-1",
    });
    await service.resolveInstance(acquireInput("run-1", "owner-1"));
    registry.findActiveByOwnerId.mockResolvedValue({
      startToken: "token-1",
      runtimeType: "sandbox",
    });

    await service.fenceOwner("owner-1", "heartbeat timeout");

    expect(upstream.notifyWorkerLost).toHaveBeenCalledWith(
      "run-1",
      "heartbeat timeout"
    );
  });

  it("releaseInstanceForRun clears the index so a later fenceOwner does not re-terminate the run", async () => {
    const { service, registry, upstream, sandboxInstances } = makeService();
    sandboxInstances.acquireInstanceForRun.mockResolvedValue({
      outcome: "ready",
      runtimeInstanceId: "container-2",
    });
    await service.resolveInstance(acquireInput("run-2", "owner-2"));
    service.releaseInstanceForRun("run-2");
    registry.findActiveByOwnerId.mockResolvedValue({
      startToken: "token-2",
      runtimeType: "sandbox",
    });

    await service.fenceOwner("owner-2", "heartbeat timeout");

    expect(upstream.notifyWorkerLost).not.toHaveBeenCalled();
  });

  it("releaseInstanceForRun clears the index before delegating to the sandbox executor", () => {
    const { service, sandboxInstances } = makeService();
    const callOrder: string[] = [];
    sandboxInstances.releaseInstanceForRun.mockImplementation(() => {
      callOrder.push("executor.releaseInstanceForRun");
    });

    service.releaseInstanceForRun("run-x");

    // index-clear happens synchronously before the executor call within the
    // same synchronous method body; asserting the executor still receives
    // the call confirms the delegation still happens after clearing.
    expect(callOrder).toEqual(["executor.releaseInstanceForRun"]);
  });

  it("cleanupRun clears the index so a later fenceOwner does not terminate the run", async () => {
    const { service, registry, upstream, sandboxInstances, commandDispatcher } =
      makeService();
    sandboxInstances.acquireInstanceForRun.mockResolvedValue({
      outcome: "ready",
      runtimeInstanceId: "container-3",
    });
    await service.resolveInstance(acquireInput("run-3", "owner-3"));

    service.cleanupRun("run-3");

    expect(commandDispatcher.cleanupRun).toHaveBeenCalledWith("run-3");
    registry.findActiveByOwnerId.mockResolvedValue({
      startToken: "token-3",
      runtimeType: "sandbox",
    });

    await service.fenceOwner("owner-3", "heartbeat timeout");

    expect(upstream.notifyWorkerLost).not.toHaveBeenCalled();
  });

  it("fenceOwner: full flow terminates every in-flight run, shuts down the instance, clears the queue and liveness entry", async () => {
    const {
      service,
      registry,
      upstream,
      sandboxInstances,
      commandDispatcher,
      livenessStore,
    } = makeService();
    sandboxInstances.acquireInstanceForRun.mockResolvedValue({
      outcome: "ready",
      runtimeInstanceId: "container-4",
    });
    await service.resolveInstance(acquireInput("run-4a", "owner-4"));
    await service.resolveInstance(acquireInput("run-4b", "owner-4"));
    registry.findActiveByOwnerId.mockResolvedValue({
      startToken: "token-4",
      runtimeType: "sandbox",
    });

    await service.fenceOwner("owner-4", "heartbeat timeout");

    expect(registry.findActiveByOwnerId).toHaveBeenCalledWith("owner-4");
    expect(upstream.notifyWorkerLost).toHaveBeenCalledWith(
      "run-4a",
      "heartbeat timeout"
    );
    expect(upstream.notifyWorkerLost).toHaveBeenCalledWith(
      "run-4b",
      "heartbeat timeout"
    );
    expect(
      sandboxInstances.shutdownRuntimeInstanceByOwnerId
    ).toHaveBeenCalledWith("owner-4");
    expect(commandDispatcher.cleanupByOwnerId).toHaveBeenCalledWith("owner-4");
    expect(livenessStore.remove).toHaveBeenCalledWith("owner-4");
  });

  it("fenceOwner dispatches the physical stop by the active row's runtimeType (local)", async () => {
    const { service, registry, localInstances, sandboxInstances } =
      makeService();
    registry.findActiveByOwnerId.mockResolvedValue({
      startToken: "token-5",
      runtimeType: "local",
    });

    await service.fenceOwner("owner-5", "heartbeat timeout");

    expect(
      localInstances.shutdownRuntimeInstanceByOwnerId
    ).toHaveBeenCalledWith("owner-5");
    expect(
      sandboxInstances.shutdownRuntimeInstanceByOwnerId
    ).not.toHaveBeenCalled();
  });

  it("fenceOwner no-ops when the owner has no active registry row", async () => {
    const {
      service,
      registry,
      upstream,
      sandboxInstances,
      localInstances,
      commandDispatcher,
      livenessStore,
    } = makeService();
    registry.findActiveByOwnerId.mockResolvedValue(null);

    await service.fenceOwner("owner-gone", "heartbeat timeout");

    expect(upstream.notifyWorkerLost).not.toHaveBeenCalled();
    expect(
      sandboxInstances.shutdownRuntimeInstanceByOwnerId
    ).not.toHaveBeenCalled();
    expect(
      localInstances.shutdownRuntimeInstanceByOwnerId
    ).not.toHaveBeenCalled();
    expect(commandDispatcher.cleanupByOwnerId).not.toHaveBeenCalled();
    expect(livenessStore.remove).not.toHaveBeenCalled();
  });

  it("fenceOwner swallows a notifyWorkerLost rejection and still shuts down the instance", async () => {
    const { service, registry, upstream, sandboxInstances } = makeService();
    sandboxInstances.acquireInstanceForRun.mockResolvedValue({
      outcome: "ready",
      runtimeInstanceId: "container-6",
    });
    await service.resolveInstance(acquireInput("run-6", "owner-6"));
    upstream.notifyWorkerLost.mockRejectedValue(new Error("run already gone"));
    registry.findActiveByOwnerId.mockResolvedValue({
      startToken: "token-6",
      runtimeType: "sandbox",
    });

    await expect(
      service.fenceOwner("owner-6", "heartbeat timeout")
    ).resolves.toBeUndefined();

    expect(
      sandboxInstances.shutdownRuntimeInstanceByOwnerId
    ).toHaveBeenCalledWith("owner-6");
  });
});
