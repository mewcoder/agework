import { describe, expect, it, vi } from "vitest";
import { upstreamMessageToRpcNotification } from "@agework/shared/protocol/rpc";
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
    upsertRunning: vi.fn().mockResolvedValue({
      resource: { id: "rr-1" },
      workspaceRuntimeInstance: { id: "wr-1" },
    }),
    markStoppedByOwner: vi.fn().mockResolvedValue(undefined),
  };
}

function makeUpstream() {
  return { sendEvent: vi.fn().mockResolvedValue(undefined) };
}

function makeExecutor(
  overrides: {
    runtimeService?: ReturnType<typeof makeRuntimeService>;
    registry?: ReturnType<typeof makeRegistry>;
    upstream?: ReturnType<typeof makeUpstream>;
  } = {}
) {
  const runtimeService = overrides.runtimeService ?? makeRuntimeService();
  const registry = overrides.registry ?? makeRegistry();
  const upstream = overrides.upstream ?? makeUpstream();
  const executor = new LocalInstanceExecutor(
    runtimeService as never,
    registry as never,
    upstream as never
  );
  return { executor, runtimeService, registry, upstream };
}

describe("LocalInstanceExecutor", () => {
  describe("acquireInstanceForRun", () => {
    it("launches a new keep-alive process, registers the channel, and writes WorkerRegistry when no active binding exists", async () => {
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
            AGEWORK_WORKER_KEEP_ALIVE: "true",
            AGEWORK_WORKER_CHANNEL: "ipc",
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
        "ipc"
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
  });

  describe("channel message handling", () => {
    it("forwards an event notification arriving over the channel to the upstream registry", async () => {
      const channel = makeChannel();
      const runtimeService = makeRuntimeService(channel);
      const { executor, upstream } = makeExecutor({ runtimeService });
      await executor.acquireInstanceForRun({
        runConfig: { runId: "run-1", workspaceId: "ws-1" } as never,
        runtimeTarget: {
          runtimeType: "local",
          ownerId: "ws-1",
          workspaceId: "ws-1",
        } as never,
      });

      channel.emit(
        "message",
        upstreamMessageToRpcNotification({
          runId: "run-1",
          seq: 1,
          type: "run.status",
          payload: { status: "running" },
          ts: "2026-01-01T00:00:00.000Z",
        })
      );
      await Promise.resolve();

      expect(upstream.sendEvent).toHaveBeenCalledWith(
        "run-1",
        expect.objectContaining({
          runId: "run-1",
          type: "run.status",
          payload: { status: "running" },
        })
      );
    });

    it("ignores a channel message that is neither an event notification nor a command result", async () => {
      const channel = makeChannel();
      const runtimeService = makeRuntimeService(channel);
      const { executor, upstream } = makeExecutor({ runtimeService });
      await executor.acquireInstanceForRun({
        runConfig: { runId: "run-1", workspaceId: "ws-1" } as never,
        runtimeTarget: {
          runtimeType: "local",
          ownerId: "ws-1",
          workspaceId: "ws-1",
        } as never,
      });

      channel.emit("message", { garbage: true });
      await Promise.resolve();

      expect(upstream.sendEvent).not.toHaveBeenCalled();
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
      expect(executor.getChannel("ws-1")).toBeUndefined();
    });
  });

  describe("sendCommand / openSession", () => {
    it("sends commands directly over the registered channel", async () => {
      const channel = makeChannel();
      const runtimeService = makeRuntimeService(channel);
      const { executor } = makeExecutor({ runtimeService });
      await executor.acquireInstanceForRun({
        runConfig: { runId: "run-1", workspaceId: "ws-1" } as never,
        runtimeTarget: {
          runtimeType: "local",
          ownerId: "ws-1",
          workspaceId: "ws-1",
        } as never,
      });
      channel.send.mockClear();

      executor.sendCommand("ws-1", {
        type: "cancel",
        commandId: "cmd-1",
        runId: "run-1",
      } as never);

      expect(channel.send).toHaveBeenCalledTimes(1);
    });

    it("sends the run config over the channel on openSession", async () => {
      const channel = makeChannel();
      const runtimeService = makeRuntimeService(channel);
      const { executor } = makeExecutor({ runtimeService });
      await executor.acquireInstanceForRun({
        runConfig: { runId: "run-1", workspaceId: "ws-1" } as never,
        runtimeTarget: {
          runtimeType: "local",
          ownerId: "ws-1",
          workspaceId: "ws-1",
        } as never,
      });
      channel.send.mockClear();

      executor.openSession("ws-1", {
        runId: "run-1",
        workspaceId: "ws-1",
      } as never);

      expect(channel.send).toHaveBeenCalledTimes(1);
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
      expect(executor.getChannel("ws-1")).toBeUndefined();
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
