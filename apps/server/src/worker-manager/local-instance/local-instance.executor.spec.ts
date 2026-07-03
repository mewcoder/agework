import { describe, expect, it, vi } from "vitest";
import { LocalInstanceExecutor } from "./local-instance.executor";

function makeChannel() {
  const handlers = new Map<string, ((...args: unknown[]) => void)[]>();
  return {
    pid: 4242,
    send: vi.fn(),
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

function makeExecutor(
  overrides: {
    runtimeService?: ReturnType<typeof makeRuntimeService>;
    registry?: ReturnType<typeof makeRegistry>;
  } = {}
) {
  const runtimeService = overrides.runtimeService ?? makeRuntimeService();
  const registry = overrides.registry ?? makeRegistry();
  const executor = new LocalInstanceExecutor(
    runtimeService as never,
    registry as never
  );
  return { executor, runtimeService, registry };
}

describe("LocalInstanceExecutor", () => {
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
        "http"
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
        "http"
      );
      expect(registry.upsertRunning).toHaveBeenCalledWith(
        {
          runtimeType: "local",
          isolationScope: "workspace",
          workspaceId: "ws-1",
          ownerId: "ws-1",
        },
        "4242:token-1",
        "http"
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
