import { describe, it, expect, vi, beforeEach } from "vitest";
import { RuntimeRunner } from "./runtime-runner";
import { RunRecordService } from "./run-record.service";
import { RuntimeActiveStore } from "./runtime-active-store";
import { RuntimeProviderRegistry } from "../providers/runtime-provider-registry";
import { ConversationService } from "../../conversations/conversation.service";
import { RunEventRecordService } from "./run-event-record.service";

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

describe("RuntimeRunner", () => {
  let service: RuntimeRunner;
  let mockRunRecordService: Partial<RunRecordService>;
  let mockRuntimeActiveStore: Partial<RuntimeActiveStore>;
  let mockProviderRegistry: Partial<RuntimeProviderRegistry>;
  let mockConversationService: Partial<ConversationService>;
  let mockRunEventRecordService: Partial<RunEventRecordService>;

  beforeEach(() => {
    mockRunRecordService = {
      create: vi.fn().mockResolvedValue({ id: "run-1" }),
      findActiveByConversationId: vi.fn().mockResolvedValue(null),
      markError: vi.fn().mockResolvedValue(undefined),
      markCancelling: vi.fn().mockResolvedValue(undefined),
      markFinished: vi.fn().mockResolvedValue(undefined),
      markCancelled: vi.fn().mockResolvedValue(undefined),
      updateRuntimeHandle: vi.fn().mockResolvedValue(undefined),
    };
    mockRuntimeActiveStore = {
      register: vi.fn(),
      unregister: vi.fn(),
      get: vi.fn().mockReturnValue(undefined),
    };
    mockProviderRegistry = {
      resolve: vi.fn().mockReturnValue({
        start: vi.fn().mockReturnValue({
          runId: "run-1",
          runtimeType: "local",
          runtimeResourceId: "1:token",
        }),
        sendControl: vi.fn(),
        cancel: vi.fn(),
      }),
    };
    mockConversationService = {
      setActiveRunStatus: vi.fn().mockResolvedValue(undefined),
    };
    mockRunEventRecordService = {
      record: vi.fn(),
    };

    service = new RuntimeRunner(
      mockRunRecordService as RunRecordService,
      mockRuntimeActiveStore as RuntimeActiveStore,
      mockProviderRegistry as RuntimeProviderRegistry,
      mockConversationService as ConversationService,
      mockRunEventRecordService as RunEventRecordService
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

      expect(mockRunRecordService.create).toHaveBeenCalledWith({
        id: "run-1",
        conversationId: "conversation-1",
        agentType: "claude",
        runtimeType: "local",
      });
      expect(mockProviderRegistry.resolve).toHaveBeenCalledWith("local");
      expect(mockRuntimeActiveStore.register).toHaveBeenCalledWith(
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
      expect(mockRunRecordService.updateRuntimeHandle).toHaveBeenCalledWith(
        "run-1",
        "local",
        "1:token"
      );
      expect(mockRunEventRecordService.record).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: "run.created" })
      );
      expect(mockRunEventRecordService.record).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: "runtime.ready" })
      );
    });

    it("persists the runtime handle once a docker provider resolves the container id asynchronously", async () => {
      const provider = {
        start: vi.fn().mockImplementation((_runConfig, _placement, onRuntimeResourceIdReady) => {
          const handle = { runId: "run-1", runtimeType: "docker", runtimeResourceId: "", conversationId: "conversation-1" };
          queueMicrotask(() => onRuntimeResourceIdReady?.("container-abc"));
          return handle;
        }),
        sendControl: vi.fn(),
        cancel: vi.fn(),
      };
      mockProviderRegistry.resolve = vi.fn().mockReturnValue(provider);

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

      expect(mockRunRecordService.updateRuntimeHandle).toHaveBeenCalledWith(
        "run-1",
        "docker",
        "container-abc"
      );
    });

    it("should rollback on provider.start() failure", async () => {
      const provider = {
        start: vi.fn().mockImplementation(() => {
          throw new Error("spawn failed");
        }),
      };
      mockProviderRegistry.resolve = vi.fn().mockReturnValue(provider);

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

      expect(mockRuntimeActiveStore.register).not.toHaveBeenCalled();
      expect(mockRunRecordService.markError).toHaveBeenCalledWith(
        "run-1",
        "Failed to start worker"
      );
      expect(mockRunEventRecordService.record).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: "runtime.start_failed" })
      );
      expect(mockConversationService.setActiveRunStatus).toHaveBeenCalledWith(
        "conversation-1",
        "error"
      );
    });
  });

  describe("sendApprovalResolved()", () => {
    it("should throw NotFoundException when no active run found", async () => {
      mockRunRecordService.findActiveByConversationId = vi.fn().mockResolvedValue(null);
      await expect(
        service.sendApprovalResolved("conversation-1", {})
      ).rejects.toThrow();
    });
  });

  describe("stop()", () => {
    it("should mark cancelled and return false when no active handle but run record exists", async () => {
      mockRunRecordService.findActiveByConversationId = vi
        .fn()
        .mockResolvedValue({ id: "run-1" });
      mockRuntimeActiveStore.get = vi.fn().mockReturnValue(undefined);

      const hadHandle = await service.stop("conversation-1");

      expect(mockRunRecordService.markCancelled).toHaveBeenCalledWith("run-1");
      expect(mockRunEventRecordService.record).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: "run.cancelled_without_handle" })
      );
      expect(hadHandle).toBe(false);
    });

    it("should cancel and return true when an active handle exists", async () => {
      mockRunRecordService.findActiveByConversationId = vi
        .fn()
        .mockResolvedValue({ id: "run-1" });
      const handle = {
        runtimeHandle: { runId: "run-1", runtimeType: "local", runtimeResourceId: "1:token", conversationId: "conversation-1" },
        stopRequested: false,
      };
      mockRuntimeActiveStore.get = vi.fn().mockReturnValue(handle);
      const provider = { cancel: vi.fn() };
      mockProviderRegistry.resolve = vi.fn().mockReturnValue(provider);

      const hadHandle = await service.stop("conversation-1");

      expect(mockRunRecordService.markCancelling).toHaveBeenCalledWith("run-1");
      expect(mockRunEventRecordService.record).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: "run.cancel_requested" })
      );
      expect(provider.cancel).toHaveBeenCalledWith(handle.runtimeHandle);
      expect(hadHandle).toBe(true);
    });
  });

  describe("attachStream()", () => {
    it("无活跃 run 时发终态 complete 快照并 end", async () => {
      mockRunRecordService.findActiveByConversationId = vi
        .fn()
        .mockResolvedValue(null);
      const res = {
        setHeader: vi.fn(),
        write: vi.fn(),
        end: vi.fn(),
        writableEnded: false,
        on: vi.fn(),
      } as any;

      await service.attachStream("conversation-1", res);

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
      mockRunRecordService.findActiveByConversationId = vi
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
      mockRuntimeActiveStore.get = vi.fn().mockReturnValue(handle);
      const res = {
        setHeader: vi.fn(),
        write: vi.fn(),
        end: vi.fn(),
        writableEnded: false,
        on: vi.fn(),
      } as any;

      await service.attachStream("conversation-1", res);

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
      mockRunRecordService.findActiveByConversationId = vi
        .fn()
        .mockResolvedValue({ id: "run-1", status: "requires_action" });
      mockRuntimeActiveStore.get = vi.fn().mockReturnValue({ runId: "run-1" });
      const res = {
        setHeader: vi.fn(),
        write: vi.fn(),
        end: vi.fn(),
        writableEnded: false,
        on: vi.fn(),
        status: vi.fn().mockReturnThis(),
      } as any;

      await service.attachStream("conversation-1", res);

      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.write).not.toHaveBeenCalled();
    });
  });
});
