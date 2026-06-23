import { describe, it, expect, vi, beforeEach } from "vitest";
import { RunService } from "./run.service";
import { RunRepository } from "./run.repository";
import { RunActiveStore } from "./execution/run-active.store";
import { RuntimeService } from "../runtime/runtime.service";
import { ConversationService } from "../conversations/conversation.service";
import { RunEventRecorder } from "./events/run-event-recorder";

function makePlacement(runtimeType: string) {
  const runtimePath = runtimeType === "local" ? "/tmp/ws" : "/workspace";
  return {
    runtimeType,
    isolationScope: "workspace" as const,
    userId: "user-1",
    workspaceId: "ws-1",
    hostPath: "/tmp/ws",
    runtimePath,
    mountTarget: runtimePath,
  };
}

describe("RunService", () => {
  let service: RunService;
  let mockRunRepository: Partial<RunRepository>;
  let mockRunActiveStore: Partial<RunActiveStore>;
  let mockRuntimeService: Partial<RuntimeService>;
  let mockConversationService: Partial<ConversationService>;
  let mockRunEventRecorder: Partial<RunEventRecorder>;

  beforeEach(() => {
    mockRunRepository = {
      create: vi.fn().mockResolvedValue({ id: "run-1" }),
      findActiveByConversationId: vi.fn().mockResolvedValue(null),
      markError: vi.fn().mockResolvedValue(undefined),
      markCancelling: vi.fn().mockResolvedValue(undefined),
      markFinished: vi.fn().mockResolvedValue(undefined),
      markCancelled: vi.fn().mockResolvedValue(undefined),
      updateRuntimeHandle: vi.fn().mockResolvedValue(undefined),
    };
    mockRunActiveStore = {
      register: vi.fn(),
      unregister: vi.fn(),
      get: vi.fn().mockReturnValue(undefined),
    };
    mockRuntimeService = {
      startWorker: vi.fn().mockReturnValue({
        runId: "run-1",
        runtimeType: "local",
        runtimeResourceId: "1:token",
      }),
      sendControl: vi.fn(),
      cancel: vi.fn(),
      heartbeat: vi.fn(),
      cleanup: vi.fn(),
    };
    mockConversationService = {
      attachMessageToRun: vi.fn().mockResolvedValue({ count: 1 }),
      setActiveRunStatus: vi.fn().mockResolvedValue(undefined),
    };
    mockRunEventRecorder = {
      append: vi.fn().mockResolvedValue({} as never),
      forgetRun: vi.fn(),
    };

    service = new RunService(
      mockRunRepository as RunRepository,
      mockRunActiveStore as RunActiveStore,
      mockRuntimeService as RuntimeService,
      mockConversationService as ConversationService,
      mockRunEventRecorder as RunEventRecorder
    );
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  describe("start()", () => {
    it("should create run, start provider and register the active runtime handle", async () => {
      const res = { on: vi.fn(), writableEnded: false } as any;
      const agentEventTrace = {
        enabled: true,
        rawFilePath: "/tmp/conversation-1.raw.jsonl",
        aguiFilePath: "/tmp/conversation-1.agui.jsonl",
        runId: "run-1",
        conversationId: "conversation-1",
        workspaceId: "ws-1",
        agentType: "claude",
      };
      const runConfig = {
        runId: "run-1",
        conversationId: "conversation-1",
        workspaceId: "ws-1",
        agentEventTrace,
      } as any;
      const aggregator = {} as any;
      const saveRun = vi.fn();

      await service.start({
        runId: "run-1",
        conversationId: "conversation-1",
        agentType: "claude",
        placement: makePlacement("local"),
        runConfig,
        res,
        aggregator,
        saveRun,
      });

      expect(mockRunRepository.create).toHaveBeenCalledWith({
        id: "run-1",
        conversationId: "conversation-1",
        agentType: "claude",
        runtimeType: "local",
      });
      expect(mockRuntimeService.startWorker).toHaveBeenCalled();
      expect(mockRunActiveStore.register).toHaveBeenCalledWith(
        "run-1",
        expect.objectContaining({
          runId: "run-1",
          conversationId: "conversation-1",
          workspaceId: "ws-1",
          agentType: "claude",
          agentEventTrace,
          res,
          aggregator,
          saveRun,
        })
      );
      expect(mockRunRepository.updateRuntimeHandle).toHaveBeenCalledWith(
        "run-1",
        "local",
        "1:token"
      );
      expect(mockRunEventRecorder.append).toHaveBeenCalledWith(
        expect.objectContaining({ type: "run.created" })
      );
      expect(mockRunEventRecorder.append).toHaveBeenCalledWith(
        expect.objectContaining({
          eventKey: "runtime:1:token:ready",
          type: "runtime.status_changed",
          data: expect.objectContaining({ status: "ready" }),
        })
      );
    });

    it("attaches the accepted user message to the created run", async () => {
      const res = { on: vi.fn(), writableEnded: false } as any;
      const runConfig = { runId: "run-1", conversationId: "conversation-1" } as any;

      await service.start({
        runId: "run-1",
        conversationId: "conversation-1",
        agentType: "claude",
        placement: makePlacement("local"),
        runConfig,
        res,
        aggregator: {} as any,
        saveRun: vi.fn(),
        userMessageId: "msg-1",
        userId: "user-1",
      });

      expect(mockConversationService.attachMessageToRun).toHaveBeenCalledWith(
        "conversation-1",
        "msg-1",
        "run-1"
      );
      expect(mockRunEventRecorder.append).toHaveBeenCalledWith(
        expect.objectContaining({
          eventKey: "message:msg-1:accepted",
          type: "message.accepted",
          targetId: "msg-1",
          refs: expect.objectContaining({
            conversationId: "conversation-1",
            messageId: "msg-1",
            userId: "user-1",
          }),
        })
      );
    });

    it("continues starting the provider when audit event recording fails", async () => {
      const startWorker = vi.fn().mockReturnValue({
        runId: "run-1",
        runtimeType: "local",
        runtimeResourceId: "1:token",
      });
      mockRuntimeService.startWorker = startWorker;
      mockRunEventRecorder.append = vi
        .fn()
        .mockRejectedValue(new Error("SQLITE_BUSY"));
      const res = { on: vi.fn(), writableEnded: false, write: vi.fn(), end: vi.fn() } as any;

      await service.start({
        runId: "run-1",
        conversationId: "conversation-1",
        agentType: "claude",
        placement: makePlacement("local"),
        runConfig: { runId: "run-1", conversationId: "conversation-1" } as any,
        res,
        aggregator: {} as any,
        saveRun: vi.fn(),
      });

      expect(startWorker).toHaveBeenCalled();
      expect(mockRunActiveStore.register).toHaveBeenCalledWith(
        "run-1",
        expect.objectContaining({ runId: "run-1" })
      );
      expect(mockRunRepository.markError).not.toHaveBeenCalled();
      expect(res.write).not.toHaveBeenCalled();
    });

    it("persists the runtime handle once a docker provider resolves the container id asynchronously", async () => {
      mockRuntimeService.startWorker = vi
        .fn()
        .mockImplementation((_runConfig, _placement, onRuntimeResourceIdReady) => {
          const handle = { runId: "run-1", runtimeType: "docker", runtimeResourceId: "", conversationId: "conversation-1" };
          queueMicrotask(() => onRuntimeResourceIdReady?.("container-abc"));
          return handle;
        });

      const res = { on: vi.fn(), writableEnded: false } as any;
      const runConfig = { runId: "run-1", conversationId: "conversation-1" } as any;

      await service.start({
        runId: "run-1",
        conversationId: "conversation-1",
        agentType: "claude",
        placement: makePlacement("docker"),
        runConfig,
        res,
        aggregator: {} as any,
        saveRun: vi.fn(),
      });

      await new Promise<void>((resolve) => queueMicrotask(resolve));

      expect(mockRunRepository.updateRuntimeHandle).toHaveBeenCalledWith(
        "run-1",
        "docker",
        "container-abc"
      );
    });

    it("should rollback on provider.start() failure", async () => {
      mockRuntimeService.startWorker = vi.fn().mockImplementation(() => {
        throw new Error("spawn failed");
      });

      const res = { on: vi.fn(), writableEnded: false, write: vi.fn(), end: vi.fn() } as any;

      await service.start({
        runId: "run-1",
        conversationId: "conversation-1",
        agentType: "claude",
        placement: makePlacement("local"),
        runConfig: {} as any,
        res,
        aggregator: {} as any,
        saveRun: vi.fn(),
      });

      expect(mockRunActiveStore.register).not.toHaveBeenCalled();
      expect(mockRunRepository.markError).toHaveBeenCalledWith(
        "run-1",
        "Failed to start worker"
      );
      expect(mockRunEventRecorder.append).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "runtime.status_changed",
          data: expect.objectContaining({ status: "start_failed" }),
        })
      );
      expect(mockConversationService.setActiveRunStatus).toHaveBeenCalledWith(
        "conversation-1",
        "error"
      );
      await Promise.resolve();
      expect(mockRunEventRecorder.forgetRun).toHaveBeenCalledWith("run-1");
    });
  });

  describe("resolveApproval()", () => {
    it("should throw NotFoundException when no active run found", async () => {
      mockRunRepository.findActiveByConversationId = vi.fn().mockResolvedValue(null);
      await expect(
        service.resolveApproval("conversation-1", {})
      ).rejects.toThrow();
    });
  });

  describe("stop()", () => {
    it("should mark cancelled and return false when no active handle but run record exists", async () => {
      mockRunRepository.findActiveByConversationId = vi
        .fn()
        .mockResolvedValue({ id: "run-1" });
      mockRunActiveStore.get = vi.fn().mockReturnValue(undefined);

      const hadHandle = await service.stop("conversation-1");

      expect(mockRunRepository.markCancelled).toHaveBeenCalledWith("run-1");
      expect(mockRunEventRecorder.append).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "run.status_changed",
          origin: "platform",
          data: expect.objectContaining({
            status: "cancelled",
            reason: "cancelled_without_handle",
          }),
        })
      );
      expect(hadHandle).toBe(false);
    });

    it("should cancel and return true when an active handle exists", async () => {
      mockRunRepository.findActiveByConversationId = vi
        .fn()
        .mockResolvedValue({ id: "run-1" });
      const handle = {
        runtimeHandle: { runId: "run-1", runtimeType: "local", runtimeResourceId: "1:token", conversationId: "conversation-1" },
        stopRequested: false,
      };
      mockRunActiveStore.get = vi.fn().mockReturnValue(handle);

      const hadHandle = await service.stop("conversation-1");

      expect(mockRunRepository.markCancelling).toHaveBeenCalledWith("run-1");
      expect(mockRunEventRecorder.append).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "run.status_changed",
          origin: "platform",
          data: expect.objectContaining({ status: "cancelling" }),
        })
      );
      expect(mockRuntimeService.cancel).toHaveBeenCalledWith(handle.runtimeHandle);
      expect(hadHandle).toBe(true);
    });
  });

  describe("resumeStream()", () => {
    it("无活跃 run 时发终态 complete 快照并 end", async () => {
      mockRunRepository.findActiveByConversationId = vi
        .fn()
        .mockResolvedValue(null);
      const res = {
        setHeader: vi.fn(),
        write: vi.fn(),
        end: vi.fn(),
        writableEnded: false,
        on: vi.fn(),
      } as any;

      await service.resumeStream("conversation-1", res);

      // 最后一次 write 是终态快照，含 complete status
      const writes = (res.write as ReturnType<typeof vi.fn>).mock.calls.map(
        (c) => c[0] as string,
      );
      expect(writes.length).toBeGreaterThan(0);
      const last = JSON.parse(writes.at(-1)!.slice(6).trim());
      expect(last.status).toEqual({ type: "complete", reason: "unknown" });
      expect(res.end).toHaveBeenCalled();
    });

    it("活跃 running run 时补发快照、替换 res、设 streamingSnapshot", async () => {
      mockRunRepository.findActiveByConversationId = vi
        .fn()
        .mockResolvedValue({ id: "run-1", status: "running" });
      const aggregator = {
        build: vi
          .fn()
          .mockReturnValue({ content: [{ type: "text", text: "hi" }], status: { type: "running" } }),
      };
      const handle = {
        runId: "run-1",
        aggregator,
        res: null as any,
        streamingSnapshot: false,
      };
      mockRunActiveStore.get = vi.fn().mockReturnValue(handle);
      const res = {
        setHeader: vi.fn(),
        write: vi.fn(),
        end: vi.fn(),
        writableEnded: false,
        on: vi.fn(),
      } as any;

      await service.resumeStream("conversation-1", res);

      // 补发了初始快照
      expect(aggregator.build).toHaveBeenCalled();
      const writes = (res.write as ReturnType<typeof vi.fn>).mock.calls.map(
        (c) => c[0] as string,
      );
      expect(writes.some((w) => w.includes("hi"))).toBe(true);
      // res 接管 + streamingSnapshot 开启
      expect(handle.res).toBe(res);
      expect(handle.streamingSnapshot).toBe(true);
    });

    it("requires_action 的 run 返回 409 不接 stream", async () => {
      mockRunRepository.findActiveByConversationId = vi
        .fn()
        .mockResolvedValue({ id: "run-1", status: "requires_action" });
      mockRunActiveStore.get = vi.fn().mockReturnValue({ runId: "run-1" });
      const res = {
        setHeader: vi.fn(),
        write: vi.fn(),
        end: vi.fn(),
        writableEnded: false,
        on: vi.fn(),
        status: vi.fn().mockReturnThis(),
      } as any;

      await service.resumeStream("conversation-1", res);

      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.write).not.toHaveBeenCalled();
    });
  });
});
