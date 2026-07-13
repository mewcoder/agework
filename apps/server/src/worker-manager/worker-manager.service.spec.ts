import { beforeEach, describe, it, expect, vi } from "vitest";
import type { RunConfig, CommandPayload } from "@agework/shared/protocol";
import { WorkerCommandDispatcher } from "./connection/command-dispatcher";
import { WorkerEndpointHandler } from "./connection/worker-endpoint.handler";
import type { WorkerUpstreamPort } from "./worker-manager.types";
import { WorkerManagerService } from "./worker-manager.service";
import type { WorkerRegistryRepository } from "./registry/worker-registry.repository";

/**
 * WorkerManagerService 是 worker-manager 唯一 export 的公开面。
 * Phase 2 后 worker 数据面(pollCommands/getRunConfig/postEvent/registerWorker)
 * 委托进程内 RuntimeHost;其余方法仍路由旧 internal provider(Phase 3 清尾)。
 */
function makeManagedHost() {
  return {
    pollCommands: vi.fn(),
    getRunConfig: vi.fn(),
    postEvent: vi.fn(),
    registerWorker: vi.fn(),
    validateWorkerToken: vi.fn(),
  };
}

function makeService() {
  const endpointHandler = {
    pollCommands: vi.fn(),
    getRunConfig: vi.fn(),
    postEvent: vi.fn(),
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
  const ownerRunStore = {
    registerRun: vi.fn(),
    unregisterRun: vi.fn(),
    listRunIdsByWorkerId: vi.fn(),
    findWorkerIdByRunId: vi.fn(),
  };
  const managedHost = makeManagedHost();
  const service = new WorkerManagerService(
    endpointHandler as unknown as WorkerEndpointHandler,
    commandDispatcher as unknown as WorkerCommandDispatcher,
    {} as unknown as WorkerRegistryRepository,
    runtimeService as never,
    provisioner as never,
    ownerRunStore as never,
    managedHost as never
  );
  return {
    service,
    endpointHandler,
    commandDispatcher,
    provisioner,
    runtimeService,
    ownerRunStore,
    managedHost,
  };
}

describe("WorkerManagerService — worker 数据面(委托进程内 RuntimeHost)", () => {
  it("pollCommands delegates to the managed host and maps commands to RPC requests", async () => {
    const { service, managedHost } = makeService();
    managedHost.pollCommands.mockResolvedValue({
      commands: [
        {
          runId: "run-1",
          seq: 3,
          type: "command",
          payload: { type: "cancel", commandId: "cmd-1", runId: "run-1" },
          ts: "t",
        },
      ],
      queueEpoch: 2,
    });

    const result = await service.pollCommands("worker-1", {
      afterSeq: 2,
      waitMs: 0,
    });

    expect(managedHost.pollCommands).toHaveBeenCalledWith("worker-1", {
      afterSeq: 2,
      waitMs: 0,
    });
    expect(result.queueEpoch).toBe(2);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({
      jsonrpc: "2.0",
      method: "run.cancel",
    });
  });

  it("getRunConfig delegates to the managed host and 404s when missing", () => {
    const { service, managedHost } = makeService();
    const config = { runId: "run-1" } as unknown as RunConfig;
    managedHost.getRunConfig.mockReturnValue(config);

    expect(service.getRunConfig("run-1")).toEqual({ config });

    managedHost.getRunConfig.mockReturnValue(undefined);
    expect(() => service.getRunConfig("run-2")).toThrow(/not found/);
  });

  it("postEvent delegates to the managed host and maps parse errors to 400", async () => {
    const { service, managedHost } = makeService();
    managedHost.postEvent.mockResolvedValue({ ok: true });

    await expect(service.postEvent("run-1", { body: true })).resolves.toEqual({
      ok: true,
    });
    expect(managedHost.postEvent).toHaveBeenCalledWith("run-1", {
      body: true,
    });

    managedHost.postEvent.mockRejectedValue(
      new Error("Invalid worker event body")
    );
    await expect(service.postEvent("run-1", null)).rejects.toMatchObject({
      status: 400,
    });
  });

  it("registerWorker delegates to the managed host handshake", async () => {
    const { service, managedHost } = makeService();
    managedHost.registerWorker.mockReturnValue(true);

    await expect(
      service.registerWorker("worker-1", { startToken: "token-1", pid: 4242 })
    ).resolves.toEqual({ ok: true });
    expect(managedHost.registerWorker).toHaveBeenCalledWith(
      "worker-1",
      "token-1",
      { pid: 4242 }
    );
  });

  it("registerWorker throws BadRequestException when the handshake is rejected", async () => {
    const { service, managedHost } = makeService();
    managedHost.registerWorker.mockReturnValue(false);

    await expect(
      service.registerWorker("worker-1", { startToken: "wrong-token" })
    ).rejects.toThrow(/no pending launch handshake/);
  });

  it("validateWorkerToken delegates to the managed host pool", () => {
    const { service, managedHost } = makeService();
    managedHost.validateWorkerToken.mockReturnValue(true);

    expect(service.validateWorkerToken("worker-1", "token-1")).toBe(true);
    expect(managedHost.validateWorkerToken).toHaveBeenCalledWith(
      "worker-1",
      "token-1"
    );
  });
});

describe("WorkerManagerService — facade routing(旧执行栈,Phase 3 清尾)", () => {
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

    expect(commandDispatcher.cleanupByWorkerId).toHaveBeenCalledWith(
      "worker-1"
    );
  });

  it("routes setUpstreamPort to the endpoint handler", () => {
    const { service, endpointHandler } = makeService();
    const receiver = {
      sendEvent: vi.fn(),
    } as unknown as WorkerUpstreamPort;

    service.setUpstreamPort(receiver);

    expect(endpointHandler.setUpstreamPort).toHaveBeenCalledWith(receiver);
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
    countRunning: vi.fn(),
    findByRuntimeId: vi.fn(),
    findRunInstanceView: vi.fn(),
    listResourcesPage: vi.fn(),
    findById: vi.fn(),
    markStoppedById: vi.fn(),
  } as unknown as WorkerRegistryRepository;
}

describe("WorkerManagerService WorkerRegistry cross-module queries", () => {
  let repository: ReturnType<typeof makeRepositoryMock>;
  let service: WorkerManagerService;

  beforeEach(() => {
    repository = makeRepositoryMock();
    service = new WorkerManagerService(
      {} as never,
      {} as never,
      repository,
      {} as never,
      {} as never,
      {} as never,
      {} as never
    );
  });

  it("findRuntimeByRuntimeId forwards to repository.findByRuntimeId", async () => {
    (repository.findByRuntimeId as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "x",
    });
    const result = await service.findRuntimeByRuntimeId("sandbox", "inst-1");
    expect(repository.findByRuntimeId).toHaveBeenCalledWith(
      "sandbox",
      "inst-1"
    );
    expect(result).toEqual({ id: "x" });
  });

  it("getWorkerStats counts running runtime resources", async () => {
    (repository.countRunning as ReturnType<typeof vi.fn>).mockResolvedValue(3);
    expect(await service.getWorkerStats()).toEqual({ activeWorkers: 3 });
  });
});

describe("WorkerManagerService runtime policy", () => {
  it("getRuntimePolicy forwards to RuntimeService", () => {
    const runtimeService = { getRuntimePolicy: vi.fn() };
    const service = new WorkerManagerService(
      {} as never,
      {} as never,
      {} as never,
      runtimeService as never,
      {} as never,
      {} as never,
      {} as never
    );
    runtimeService.getRuntimePolicy.mockReturnValue({ runtimeType: "native" });
    expect(service.getRuntimePolicy()).toEqual({ runtimeType: "native" });
  });
});

describe("WorkerManagerService.stopWorkerInstance", () => {
  function makeStopService() {
    const registry = {
      findById: vi.fn(),
      markStoppedById: vi.fn().mockResolvedValue(undefined),
    };
    const provisioner = { stop: vi.fn().mockResolvedValue(undefined) };
    const service = new WorkerManagerService(
      {} as never,
      {} as never,
      registry as never,
      {} as never,
      provisioner as never,
      {} as never,
      {} as never
    );
    return { service, registry, provisioner };
  }

  it("tears down the sandbox resource through the provisioner using a ref built from the DB row", async () => {
    const { service, registry, provisioner } = makeStopService();
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

  it("throws when the resource is missing or not running", async () => {
    const { service, registry, provisioner } = makeStopService();
    registry.findById.mockResolvedValue({ status: "stopped" });

    await expect(service.stopWorkerInstance("rr-3")).rejects.toThrow(
      "not found or not running"
    );
    expect(registry.markStoppedById).not.toHaveBeenCalled();
    expect(provisioner.stop).not.toHaveBeenCalled();
  });
});

describe("WorkerManagerService — resolveInstance/releaseInstanceForRun(旧栈,Phase 3 清尾)", () => {
  function makeOldStackService() {
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
      provisioner as never,
      ownerRunStore as never,
      {} as never
    );
    return { service, provisioner, ownerRunStore };
  }

  it("resolveInstance forwards placements to the provisioner and registers the run in the owner index", async () => {
    const { service, provisioner, ownerRunStore } = makeOldStackService();
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

  it("releaseInstanceForRun only clears the owner index (no reclaim/instance-side action)", () => {
    const { service, provisioner, ownerRunStore } = makeOldStackService();
    service.releaseInstanceForRun("run-1");
    expect(ownerRunStore.unregisterRun).toHaveBeenCalledWith("run-1");
    expect(provisioner.acquireInstanceForRun).not.toHaveBeenCalled();
    expect(provisioner.stop).not.toHaveBeenCalled();
  });
});
