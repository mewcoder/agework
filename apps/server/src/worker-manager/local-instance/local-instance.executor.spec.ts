import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { LocalInstanceExecutor } from "./local-instance.executor";

function makeChannel() {
  const handlers = new Map<string, ((...args: unknown[]) => void)[]>();
  return {
    pid: 4242,
    send: vi.fn(),
    killed: false,
    kill: vi.fn(),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    }),
    emit(event: string, ...args: unknown[]) {
      for (const handler of handlers.get(event) ?? []) handler(...args);
    },
  };
}

function makeRuntimeService(channel = makeChannel()) {
  return {
    launchLocal: vi.fn().mockReturnValue({
      runtimeInstanceId: "4242:token-1",
      channel,
    }),
    recoverOrphanLocal: vi.fn().mockResolvedValue(undefined),
  };
}

function makeRegistry() {
  return {
    findActiveByWorkspace: vi.fn().mockResolvedValue(null),
    insertStarting: vi.fn().mockResolvedValue({ ok: true }),
    upsertRunning: vi.fn().mockResolvedValue({
      resource: { id: "rr-1" },
      workspaceWorkerBinding: { id: "wr-1" },
    }),
    markStoppedByOwner: vi.fn().mockResolvedValue(undefined),
    markErrorByOwner: vi.fn().mockResolvedValue(undefined),
  };
}

const DEFAULT_HANDSHAKE = {
  pid: 4242,
  registeredAt: "2026-01-01T00:00:00.000Z",
};

/**
 * 默认自动 resolve(模拟 register 秒回),让不关心握手细节的既有用例保持
 * 原有的"一步到位"行为;需要控制握手时机的用例自行覆盖 waitForRegister 实现。
 */
function makeHandshakeStore() {
  return {
    waitForRegister: vi.fn().mockResolvedValue(DEFAULT_HANDSHAKE),
    cancel: vi.fn(),
    registerWorker: vi.fn(),
  };
}

function makeConfigService() {
  return {
    getLaunchTimeoutSeconds: vi.fn().mockReturnValue(60),
  };
}

function makeExecutor(
  overrides: {
    runtimeService?: ReturnType<typeof makeRuntimeService>;
    registry?: ReturnType<typeof makeRegistry>;
    handshakeStore?: ReturnType<typeof makeHandshakeStore>;
    configService?: ReturnType<typeof makeConfigService>;
  } = {}
) {
  const runtimeService = overrides.runtimeService ?? makeRuntimeService();
  const registry = overrides.registry ?? makeRegistry();
  const handshakeStore = overrides.handshakeStore ?? makeHandshakeStore();
  const configService = overrides.configService ?? makeConfigService();
  const executor = new LocalInstanceExecutor(
    runtimeService as never,
    registry as never,
    handshakeStore as never,
    configService as never
  );
  return { executor, runtimeService, registry, handshakeStore, configService };
}

describe("LocalInstanceExecutor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("acquireInstanceForRun", () => {
    it("launches a new resident worker process, registers the channel, and writes WorkerRegistry when no active binding exists", async () => {
      const { executor, runtimeService, registry } = makeExecutor();

      const result = await executor.acquireInstanceForRun({
        runConfig: { runId: "run-1", workspaceId: "ws-1" } as never,
        runtimeTarget: {
          runtimeType: "local",
          ownerId: "ws-1",
          workspaceId: "ws-1",
        } as never,
      });

      expect(runtimeService.launchLocal).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: "run-1",
          env: expect.objectContaining({
            AGEWORK_WORKER_ROLE: "worker",
            AGEWORK_WORKER_API_BASE: expect.stringContaining("/api/v1"),
            AGEWORK_WORKER_OWNER_ID: "ws-1",
            AGEWORK_WORKER_START_TOKEN: expect.any(String),
            AGEWORK_WORKER_RUNTIME_TYPE: "local",
            AGEWORK_WORKER_ISOLATION_SCOPE: "workspace",
          }),
        })
      );
      expect(registry.upsertRunning).toHaveBeenCalledWith(
        {
          runtimeType: "local",
          isolationScope: "workspace",
          workspaceId: "ws-1",
          ownerId: "ws-1",
        },
        "4242:token-1",
        "http",
        { pid: 4242, registeredAt: "2026-01-01T00:00:00.000Z" }
      );
      expect(result).toEqual({
        outcome: "ready",
        runtimeInstanceId: "4242:token-1",
      });
    });

    it("reuses an existing live channel for the same owner without launching a new process", async () => {
      const { executor, runtimeService } = makeExecutor();
      await executor.acquireInstanceForRun({
        runConfig: { runId: "run-1", workspaceId: "ws-1" } as never,
        runtimeTarget: {
          runtimeType: "local",
          ownerId: "ws-1",
          workspaceId: "ws-1",
        } as never,
      });
      runtimeService.launchLocal.mockClear();

      const result = await executor.acquireInstanceForRun({
        runConfig: { runId: "run-2", workspaceId: "ws-1" } as never,
        runtimeTarget: {
          runtimeType: "local",
          ownerId: "ws-1",
          workspaceId: "ws-1",
        } as never,
      });

      expect(runtimeService.launchLocal).not.toHaveBeenCalled();
      expect(result).toEqual({
        outcome: "ready",
        runtimeInstanceId: "4242:token-1",
      });
    });

    it("writes a starting row before launching, then flips it to running", async () => {
      const { executor, registry } = makeExecutor();

      await executor.acquireInstanceForRun({
        runConfig: { runId: "run-1", workspaceId: "ws-1" } as never,
        runtimeTarget: {
          runtimeType: "local",
          ownerId: "ws-1",
          workspaceId: "ws-1",
        } as never,
      });

      expect(registry.insertStarting).toHaveBeenCalledWith(
        {
          runtimeType: "local",
          isolationScope: "workspace",
          workspaceId: "ws-1",
          ownerId: "ws-1",
        },
        expect.any(String),
        "http",
        expect.any(String)
      );
      expect(registry.upsertRunning).toHaveBeenCalledWith(
        {
          runtimeType: "local",
          isolationScope: "workspace",
          workspaceId: "ws-1",
          ownerId: "ws-1",
        },
        "4242:token-1",
        "http",
        { pid: 4242, registeredAt: "2026-01-01T00:00:00.000Z" }
      );
    });

    it("resolves error on insertStarting conflict without forking a process (local can never reattach across restarts)", async () => {
      const { executor, runtimeService, registry } = makeExecutor();
      registry.insertStarting.mockResolvedValueOnce({
        ok: false,
        existing: { runtimeInstanceId: "9999:stale-token", status: "running" },
      });

      const result = await executor.acquireInstanceForRun({
        runConfig: { runId: "run-1", workspaceId: "ws-1" } as never,
        runtimeTarget: {
          runtimeType: "local",
          ownerId: "ws-1",
          workspaceId: "ws-1",
        } as never,
      });

      expect(result.outcome).toBe("error");
      expect(runtimeService.launchLocal).not.toHaveBeenCalled();
    });

    it("marks the row as error when launchLocal throws synchronously", async () => {
      const runtimeService = makeRuntimeService();
      runtimeService.launchLocal.mockImplementation(() => {
        throw new Error("fork failed: EAGAIN");
      });
      const { executor, registry } = makeExecutor({ runtimeService });

      const result = await executor.acquireInstanceForRun({
        runConfig: { runId: "run-1", workspaceId: "ws-1" } as never,
        runtimeTarget: {
          runtimeType: "local",
          ownerId: "ws-1",
          workspaceId: "ws-1",
        } as never,
      });

      expect(result.outcome).toBe("error");
      expect(registry.markErrorByOwner).toHaveBeenCalledWith(
        "local",
        "workspace",
        "ws-1",
        expect.stringContaining("fork failed")
      );
    });

    it("settles ready only after the worker registers (waitForRegister gates readiness)", async () => {
      const handshakeStore = makeHandshakeStore();
      let resolveHandshake!: (result: {
        pid?: number;
        registeredAt: string;
      }) => void;
      handshakeStore.waitForRegister.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveHandshake = resolve;
          })
      );
      const { executor, registry } = makeExecutor({ handshakeStore });

      const acquire = executor.acquireInstanceForRun({
        runConfig: { runId: "run-1", workspaceId: "ws-1" } as never,
        runtimeTarget: {
          runtimeType: "local",
          ownerId: "ws-1",
          workspaceId: "ws-1",
        } as never,
      });
      await Promise.resolve();
      await Promise.resolve();
      // process forked already, but no register yet — must not be settled/recorded.
      expect(registry.upsertRunning).not.toHaveBeenCalled();

      resolveHandshake({ pid: 999, registeredAt: "2026-03-03T00:00:00.000Z" });
      const result = await acquire;

      expect(result).toEqual({
        outcome: "ready",
        runtimeInstanceId: "4242:token-1",
      });
      expect(registry.upsertRunning).toHaveBeenCalledWith(
        {
          runtimeType: "local",
          isolationScope: "workspace",
          workspaceId: "ws-1",
          ownerId: "ws-1",
        },
        "4242:token-1",
        "http",
        { pid: 999, registeredAt: "2026-03-03T00:00:00.000Z" }
      );
    });

    it("kills the forked process and marks the row as error when register never arrives within the launch timeout", async () => {
      const channel = makeChannel();
      const runtimeService = makeRuntimeService(channel);
      const handshakeStore = makeHandshakeStore();
      handshakeStore.waitForRegister.mockImplementation(
        () =>
          new Promise(() => {
            /* register never arrives */
          })
      );
      const configService = makeConfigService();
      configService.getLaunchTimeoutSeconds.mockReturnValue(1);
      const { executor, registry } = makeExecutor({
        runtimeService,
        handshakeStore,
        configService,
      });

      const acquire = executor.acquireInstanceForRun({
        runConfig: { runId: "run-1", workspaceId: "ws-1" } as never,
        runtimeTarget: {
          runtimeType: "local",
          ownerId: "ws-1",
          workspaceId: "ws-1",
        } as never,
      });
      await vi.advanceTimersByTimeAsync(1_000);
      const result = await acquire;

      expect(result.outcome).toBe("error");
      expect(channel.kill).toHaveBeenCalledWith("SIGTERM");
      expect(handshakeStore.cancel).toHaveBeenCalledWith(
        "ws-1",
        expect.any(String)
      );
      expect(registry.markErrorByOwner).toHaveBeenCalledWith(
        "local",
        "workspace",
        "ws-1",
        expect.stringContaining("timed out")
      );
    });
  });

  describe("channel exit handling", () => {
    it("marks the owner stopped in WorkerRegistry and removes the in-memory binding when the process exits", async () => {
      const channel = makeChannel();
      const runtimeService = makeRuntimeService(channel);
      const { executor, registry } = makeExecutor({ runtimeService });
      await executor.acquireInstanceForRun({
        runConfig: { runId: "run-1", workspaceId: "ws-1" } as never,
        runtimeTarget: {
          runtimeType: "local",
          ownerId: "ws-1",
          workspaceId: "ws-1",
        } as never,
      });

      channel.emit("exit", 1);
      await Promise.resolve();

      expect(registry.markStoppedByOwner).toHaveBeenCalledWith(
        "local",
        "workspace",
        "ws-1"
      );

      // in-memory binding cleared: acquiring again for the same owner forks a new process.
      runtimeService.launchLocal.mockClear();
      await executor.acquireInstanceForRun({
        runConfig: { runId: "run-2", workspaceId: "ws-1" } as never,
        runtimeTarget: {
          runtimeType: "local",
          ownerId: "ws-1",
          workspaceId: "ws-1",
        } as never,
      });
      expect(runtimeService.launchLocal).toHaveBeenCalled();
    });
  });

  describe("shutdownRuntimeInstanceByOwnerId", () => {
    it("kills the channel, marks WorkerRegistry stopped, and clears the in-memory binding", async () => {
      const channel = makeChannel();
      const runtimeService = makeRuntimeService(channel);
      const { executor, registry } = makeExecutor({ runtimeService });
      await executor.acquireInstanceForRun({
        runConfig: { runId: "run-1", workspaceId: "ws-1" } as never,
        runtimeTarget: {
          runtimeType: "local",
          ownerId: "ws-1",
          workspaceId: "ws-1",
        } as never,
      });

      executor.shutdownRuntimeInstanceByOwnerId("ws-1");

      expect(channel.kill).toHaveBeenCalledWith("SIGTERM");
      expect(registry.markStoppedByOwner).toHaveBeenCalledWith(
        "local",
        "workspace",
        "ws-1"
      );

      // in-memory binding cleared: acquiring again for the same owner forks a new process.
      runtimeService.launchLocal.mockClear();
      await executor.acquireInstanceForRun({
        runConfig: { runId: "run-2", workspaceId: "ws-1" } as never,
        runtimeTarget: {
          runtimeType: "local",
          ownerId: "ws-1",
          workspaceId: "ws-1",
        } as never,
      });
      expect(runtimeService.launchLocal).toHaveBeenCalled();
    });

    it("is a no-op when the owner has no registered channel", () => {
      const { executor, registry } = makeExecutor();
      expect(() =>
        executor.shutdownRuntimeInstanceByOwnerId("unknown")
      ).not.toThrow();
      expect(registry.markStoppedByOwner).not.toHaveBeenCalled();
    });
  });

  describe("recoverOrphan", () => {
    it("delegates to RuntimeService.recoverOrphanLocal", async () => {
      const { executor, runtimeService } = makeExecutor();
      await executor.recoverOrphan("4242:token-1");
      expect(runtimeService.recoverOrphanLocal).toHaveBeenCalledWith(
        "4242:token-1"
      );
    });
  });
});
