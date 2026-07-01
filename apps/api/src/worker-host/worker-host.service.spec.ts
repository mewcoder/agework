import { beforeEach, describe, it, expect, vi } from "vitest";
import type { RunConfig, CommandPayload } from "@agework/shared/protocol";
import { WorkerCommandDispatcher } from "./command/command-dispatcher.service";
import { WorkerUpstreamRegistry } from "./upstream/worker-upstream.registry";
import { WorkerEndpointHandler } from "./worker-endpoint.handler";
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
  const service = new WorkerHostService(
    endpointHandler as unknown as WorkerEndpointHandler,
    upstream as unknown as WorkerUpstreamRegistry,
    commandDispatcher as unknown as WorkerCommandDispatcher,
    {} as unknown as WorkerRegistryRepository
  );
  return { service, endpointHandler, upstream, commandDispatcher };
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
});

function makeRepositoryMock() {
  return {
    findActiveByWorkspace: vi.fn(),
    upsertRunning: vi.fn(),
    markStoppedByOwner: vi.fn(),
    markErrorByOwner: vi.fn(),
    isRuntimeInstanceBoundToWorkspace: vi.fn(),
    countRunning: vi.fn(),
    findAllRunning: vi.fn(),
    findByRuntimeId: vi.fn(),
    findRunInstanceView: vi.fn(),
    userExists: vi.fn(),
    listResourcesPage: vi.fn(),
    findById: vi.fn(),
    findBindingWithResource: vi.fn(),
    findWorkspaceIdsByUser: vi.fn(),
    findRunningByOwners: vi.fn(),
    markStoppedById: vi.fn(),
    deleteWorkspaceBinding: vi.fn(),
  } as unknown as WorkerRegistryRepository;
}

describe("WorkerHostService WorkerRegistry pass-through methods", () => {
  let repository: ReturnType<typeof makeRepositoryMock>;
  let service: WorkerHostService;

  beforeEach(() => {
    repository = makeRepositoryMock();
    service = new WorkerHostService(
      {} as any,
      {} as any,
      {} as any,
      repository
    );
  });

  it("upsertRunningRuntime forwards to repository.upsertRunning", async () => {
    const placement = { runtimeType: "sandbox" } as any;
    (repository.upsertRunning as any).mockResolvedValue({
      resource: { id: "x" },
    });
    const result = await service.upsertRunningRuntime(
      placement,
      "ws-1",
      "inst-1"
    );
    expect(repository.upsertRunning).toHaveBeenCalledWith(
      placement,
      "ws-1",
      "inst-1",
      undefined
    );
    expect(result).toEqual({ resource: { id: "x" } });
  });

  it("markRuntimeStoppedByOwner forwards args to repository.markStoppedByOwner", async () => {
    await service.markRuntimeStoppedByOwner("sandbox", "workspace", "ws-1");
    expect(repository.markStoppedByOwner).toHaveBeenCalledWith(
      "sandbox",
      "workspace",
      "ws-1"
    );
  });

  it("isRuntimeInstanceBoundToWorkspace forwards to repository and returns its result", async () => {
    (repository.isRuntimeInstanceBoundToWorkspace as any).mockResolvedValue(
      true
    );
    const result = await service.isRuntimeInstanceBoundToWorkspace(
      "sandbox",
      "ws-1",
      "inst-1"
    );
    expect(result).toBe(true);
    expect(repository.isRuntimeInstanceBoundToWorkspace).toHaveBeenCalledWith(
      "sandbox",
      "ws-1",
      "inst-1"
    );
  });

  it("countRunningRuntimes forwards to repository.countRunning", async () => {
    (repository.countRunning as any).mockResolvedValue(3);
    expect(await service.countRunningRuntimes()).toBe(3);
  });

  it("findRuntimeInstanceView forwards args and result", async () => {
    (repository.findRunInstanceView as any).mockResolvedValue({ id: "x" });
    const result = await service.findRuntimeInstanceView("sandbox", "inst-1");
    expect(repository.findRunInstanceView).toHaveBeenCalledWith(
      "sandbox",
      "inst-1"
    );
    expect(result).toEqual({ id: "x" });
  });
});
