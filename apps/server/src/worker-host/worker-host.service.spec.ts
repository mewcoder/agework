import { beforeEach, describe, it, expect, vi } from "vitest";
import type { RunConfig, CommandPayload } from "@agework/shared/protocol";
import { WorkerCommandDispatcher } from "./command/command-dispatcher.service";
import { WorkerUpstreamRegistry } from "./upstream/worker-upstream.registry";
import { WorkerEndpointHandler } from "./endpoint/worker-endpoint.handler";
import type { WorkerUpstreamPort } from "./worker-host.types";
import { WorkerHostService } from "./worker-host.service";
import type { WorkerRegistryRepository } from "./registry/worker-registry.repository";

/**
 * WorkerHostService 是 worker-host 唯一 export 的公开面,所有跨模块调用方
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
  const localInstances = {
    has: vi.fn().mockReturnValue(false),
  };
  const runtimeService = {
    resolveRuntimeTarget: vi.fn(),
  };
  const service = new WorkerHostService(
    endpointHandler as unknown as WorkerEndpointHandler,
    upstream as unknown as WorkerUpstreamRegistry,
    commandDispatcher as unknown as WorkerCommandDispatcher,
    {} as unknown as WorkerRegistryRepository,
    runtimeService as never,
    {} as never,
    localInstances as never
  );
  return {
    service,
    endpointHandler,
    upstream,
    commandDispatcher,
    runtimeService,
  };
}

describe("WorkerHostService — facade routing", () => {
  it("routes pollCommands to the endpoint handler", async () => {
    const { service, endpointHandler } = makeService();
    endpointHandler.pollCommands.mockResolvedValue({ messages: [] });

    await service.pollCommands("owner-1", { afterSeq: 3, waitMs: 0 });

    expect(endpointHandler.pollCommands).toHaveBeenCalledWith("owner-1", {
      afterSeq: 3,
      waitMs: 0,
    });
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

describe("WorkerHostService WorkerRegistry cross-module queries", () => {
  let repository: ReturnType<typeof makeRepositoryMock>;
  let service: WorkerHostService;

  beforeEach(() => {
    repository = makeRepositoryMock();
    service = new WorkerHostService(
      {} as any,
      {} as any,
      {} as any,
      repository,
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

describe("WorkerHostService sandbox instance orchestration", () => {
  function makeService() {
    const runtimeService = { getRuntimePolicy: vi.fn() };
    const sandboxInstances = {
      acquireInstanceForRun: vi.fn(),
      releaseInstanceForRun: vi.fn(),
      recoverOrphan: vi.fn(),
      shutdownRuntimeInstanceByOwnerId: vi.fn(),
    };
    const service = new WorkerHostService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      runtimeService as never,
      sandboxInstances as never,
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

describe("WorkerHostService local instance orchestration", () => {
  function makeService() {
    const localInstances = {
      has: vi.fn().mockReturnValue(false),
      acquireInstanceForRun: vi.fn(),
      releaseInstanceForRun: vi.fn(),
      recoverOrphan: vi.fn(),
      shutdownRuntimeInstanceByOwnerId: vi.fn(),
      sendCommand: vi.fn(),
      openSession: vi.fn(),
    };
    const commandDispatcher = {
      openSession: vi.fn(),
      sendCommand: vi.fn(),
      cleanupRun: vi.fn(),
      cleanupByOwnerId: vi.fn(),
    };
    const service = new WorkerHostService(
      {} as never,
      {} as never,
      commandDispatcher as never,
      {} as never,
      {} as never,
      {} as never,
      localInstances as never
    );
    return { service, localInstances, commandDispatcher };
  }

  // 命令路由以 LocalInstanceExecutor 当前是否持有该 owner 的存活实例为准;
  // 查不到(含重启后内存清空、进程已 exit)一律回落 HTTP dispatcher。

  it("sendCommand routes through the local executor when the owner holds a live local instance", () => {
    const { service, localInstances, commandDispatcher } = makeService();
    localInstances.has.mockReturnValue(true);

    service.sendCommand("ws-1", "run-1", { type: "cancel" } as never);

    expect(localInstances.sendCommand).toHaveBeenCalledWith("ws-1", {
      type: "cancel",
    });
    expect(commandDispatcher.sendCommand).not.toHaveBeenCalled();
  });

  it("sendCommand falls back to the HTTP queue for an owner with no live local instance", () => {
    const { service, localInstances, commandDispatcher } = makeService();

    service.sendCommand("ws-1", "run-1", { type: "cancel" } as never);

    expect(commandDispatcher.sendCommand).toHaveBeenCalledWith(
      "ws-1",
      "run-1",
      {
        type: "cancel",
      }
    );
    expect(localInstances.sendCommand).not.toHaveBeenCalled();
  });

  it("openSession routes through the local executor when the owner holds a live local instance", () => {
    const { service, localInstances, commandDispatcher } = makeService();
    localInstances.has.mockReturnValue(true);
    const params = { runId: "run-1", ownerId: "ws-1", runConfig: {} as never };

    service.openSession(params);

    expect(localInstances.openSession).toHaveBeenCalledWith(
      "ws-1",
      params.runConfig
    );
    expect(commandDispatcher.openSession).not.toHaveBeenCalled();
  });
});

describe("WorkerHostService.stopRuntimeInstance", () => {
  function makeService() {
    const registry = {
      findById: vi.fn(),
      markStoppedById: vi.fn().mockResolvedValue(undefined),
    };
    const sandboxInstances = { shutdownRuntimeInstanceByOwnerId: vi.fn() };
    const localInstances = {
      shutdownRuntimeInstanceByOwnerId: vi.fn(),
    };
    const service = new WorkerHostService(
      {} as never,
      {} as never,
      {} as never,
      registry as never,
      {} as never,
      sandboxInstances as never,
      localInstances as never
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

describe("WorkerHostService — resolveInstance unified dispatch", () => {
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
    const service = new WorkerHostService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      sandboxInstances as never,
      localInstances as never
    );
    return { service, sandboxInstances, localInstances };
  }

  it("resolveInstance dispatches to the local executor for local placements", async () => {
    const { service, localInstances } = makeService();
    const input = { runtimeTarget: { runtimeType: "local" } } as never;
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
    const input = { runtimeTarget: { runtimeType: "sandbox" } } as never;
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
