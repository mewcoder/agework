import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RuntimeHostContract } from "@agework/shared/protocol";
import { RunService } from "./run.service";
import { RunRepository } from "./run.repository";
import { LiveRunRegistry } from "./live-run/live-run.registry";
import { RunEventService } from "../run-event/run-event.service";
import { RunStatusService } from "./status/run-status.service";
import { RunLauncher } from "./launch/run.launcher";
import { RunRecoveryService } from "./recovery/run-recovery.service";

describe("RunService", () => {
  let service: RunService;
  let mockRunRepository: Partial<RunRepository>;
  let mockLiveRunRegistry: Partial<LiveRunRegistry>;
  let mockRuntimeHost: Partial<RuntimeHostContract>;
  let mockRunEvents: RunEventService;
  let mockRunStatusService: Partial<RunStatusService>;
  let mockRunLauncher: Partial<RunLauncher>;
  let mockRunRecovery: Partial<RunRecoveryService>;

  beforeEach(() => {
    mockRunRepository = {
      findActiveByConversationId: vi.fn().mockResolvedValue(null),
      markCancelling: vi.fn().mockResolvedValue(undefined),
      markCancelled: vi.fn().mockResolvedValue(undefined),
      findConversationId: vi.fn().mockResolvedValue(null),
    };
    mockLiveRunRegistry = {
      get: vi.fn().mockReturnValue(undefined),
    };
    mockRuntimeHost = {
      command: vi.fn().mockResolvedValue(undefined),
      listWorkers: vi.fn().mockResolvedValue([]),
    };
    mockRunEvents = new RunEventService({} as never, {} as never, {} as never);
    vi.spyOn(mockRunEvents, "append").mockResolvedValue({} as never);
    mockRunStatusService = {
      markCancelRequested: vi.fn().mockResolvedValue(undefined),
      markCancelledWithoutHandle: vi.fn().mockResolvedValue(undefined),
    };
    mockRunLauncher = {
      launch: vi.fn().mockResolvedValue(undefined),
    };
    mockRunRecovery = {
      failInterruptedRuns: vi.fn().mockResolvedValue(undefined),
    };

    service = new RunService(
      mockRunRepository as RunRepository,
      mockLiveRunRegistry as LiveRunRegistry,
      mockRuntimeHost as RuntimeHostContract,
      mockRunEvents,
      mockRunStatusService as RunStatusService,
      mockRunLauncher as RunLauncher,
      mockRunRecovery as RunRecoveryService
    );
  });

  describe("start()", () => {
    it("delegates to RunLauncher with a stopActiveRun port", async () => {
      const input = { conversationId: "conversation-1" } as never;
      await service.start(input);

      expect(mockRunLauncher.launch).toHaveBeenCalledWith(
        input,
        expect.objectContaining({ stopActiveRun: expect.any(Function) })
      );
    });
  });

  describe("onApplicationBootstrap()", () => {
    it("runs startup recovery once even if invoked again", async () => {
      await service.onApplicationBootstrap();
      await service.onApplicationBootstrap();

      expect(mockRunRecovery.failInterruptedRuns).toHaveBeenCalledTimes(1);
    });
  });

  describe("stopForWorkspace()", () => {
    it("stops every active run conversation for the workspace", async () => {
      mockRunRepository.findActiveConversationIdsForWorkspace = vi
        .fn()
        .mockResolvedValue(["conversation-1", "conversation-2"]);
      const stop = vi.spyOn(service, "stop").mockResolvedValue(true);

      await service.stopForWorkspace("ws-1");

      expect(
        mockRunRepository.findActiveConversationIdsForWorkspace
      ).toHaveBeenCalledWith("ws-1");
      expect(stop).toHaveBeenCalledWith("conversation-1");
      expect(stop).toHaveBeenCalledWith("conversation-2");
    });
  });

  describe("resumeWithAnswers()", () => {
    const resumeEntries = [
      {
        interruptId: "int-1",
        status: "resolved",
        payload: { answers: { decision: "yes" } },
      },
    ];

    function makeRes() {
      return {} as never;
    }

    function makeHandle() {
      return {
        runId: "run-1",
        runtimeHandle: {
          runId: "run-1",
          runtimeHostId: "builtin",
          runtimeType: "native",
          conversationId: "conversation-1",
        },
        stream: {
          replace: vi.fn(),
          onClose: vi.fn(),
          isAttachedTo: vi.fn().mockReturnValue(false),
          detach: vi.fn(),
        },
      };
    }

    it("throws Conflict when no active run found", async () => {
      mockRunRepository.findActiveByConversationId = vi
        .fn()
        .mockResolvedValue(null);
      await expect(
        service.resumeWithAnswers({
          conversationId: "conversation-1",
          resumeRunId: "run-2",
          resume: resumeEntries,
          res: makeRes(),
        })
      ).rejects.toThrow("No pending question");
    });

    it("throws Conflict when the active run is not awaiting an answer", async () => {
      mockRunRepository.findActiveByConversationId = vi
        .fn()
        .mockResolvedValue({ id: "run-1", status: "running" });
      mockLiveRunRegistry.get = vi.fn().mockReturnValue(makeHandle());
      await expect(
        service.resumeWithAnswers({
          conversationId: "conversation-1",
          resumeRunId: "run-2",
          resume: resumeEntries,
          res: makeRes(),
        })
      ).rejects.toThrow("No pending question");
    });

    it("rejects malformed resume entries before touching the run", async () => {
      await expect(
        service.resumeWithAnswers({
          conversationId: "conversation-1",
          resumeRunId: "run-2",
          resume: [{ interruptId: "int-1", status: "cancelled" }],
          res: makeRes(),
        })
      ).rejects.toThrow("No pending question");
      expect(mockRunRepository.findActiveByConversationId).toHaveBeenCalled();
    });

    it("attaches the stream in event mode then dispatches approval with resumeRunId", async () => {
      mockRunRepository.findActiveByConversationId = vi
        .fn()
        .mockResolvedValue({ id: "run-1", status: "requires_action" });
      const handle = makeHandle();
      mockLiveRunRegistry.get = vi.fn().mockReturnValue(handle);
      const res = makeRes();

      await service.resumeWithAnswers({
        conversationId: "conversation-1",
        resumeRunId: "run-2",
        resume: resumeEntries,
        res,
      });

      expect(handle.stream.replace).toHaveBeenCalledWith(res, "events");
      expect(mockRuntimeHost.command).toHaveBeenCalledWith(
        expect.objectContaining({
          runtimeHostId: "builtin",
          payload: expect.objectContaining({
            type: "approval_resolved",
            runId: "run-1",
            conversationId: "conversation-1",
            payload: { answers: { decision: "yes" } },
            resumeRunId: "run-2",
          }),
        })
      );
      // 附接先于命令下发,续接段的 RUN_STARTED 不会漏
      const replaceOrder = (handle.stream.replace as ReturnType<typeof vi.fn>)
        .mock.invocationCallOrder[0];
      const sendOrder = (mockRuntimeHost.command as ReturnType<typeof vi.fn>)
        .mock.invocationCallOrder[0];
      expect(replaceOrder).toBeLessThan(sendOrder);
      expect(mockRunEvents.append).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: "run-1",
          type: "permission.resolved",
        })
      );
    });

    it("dispatches approval_resolved with opaque payload for Codex decision", async () => {
      mockRunRepository.findActiveByConversationId = vi
        .fn()
        .mockResolvedValue({ id: "run-1", status: "requires_action" });
      const handle = makeHandle();
      mockLiveRunRegistry.get = vi.fn().mockReturnValue(handle);

      await service.resumeWithAnswers({
        conversationId: "conversation-1",
        resumeRunId: "run-2",
        resume: [
          {
            interruptId: "int-1",
            status: "resolved",
            payload: { decision: "accept" },
          },
        ],
        res: makeRes(),
      });

      expect(mockRuntimeHost.command).toHaveBeenCalledWith(
        expect.objectContaining({
          runtimeHostId: "builtin",
          payload: expect.objectContaining({
            type: "approval_resolved",
            runId: "run-1",
            payload: { decision: "accept" },
          }),
        })
      );
    });

    it("dispatches approval_resolved with {status: cancelled} when user cancels", async () => {
      mockRunRepository.findActiveByConversationId = vi
        .fn()
        .mockResolvedValue({ id: "run-1", status: "requires_action" });
      const handle = makeHandle();
      mockLiveRunRegistry.get = vi.fn().mockReturnValue(handle);

      await service.resumeWithAnswers({
        conversationId: "conversation-1",
        resumeRunId: "run-2",
        resume: [
          {
            interruptId: "int-1",
            status: "cancelled",
          },
        ],
        res: makeRes(),
      });

      expect(mockRuntimeHost.command).toHaveBeenCalledWith(
        expect.objectContaining({
          runtimeHostId: "builtin",
          payload: expect.objectContaining({
            type: "approval_resolved",
            runId: "run-1",
            payload: { status: "cancelled" },
          }),
        })
      );
    });

    it("dispatches approval_resolved with permission payload for Codex permissions", async () => {
      mockRunRepository.findActiveByConversationId = vi
        .fn()
        .mockResolvedValue({ id: "run-1", status: "requires_action" });
      const handle = makeHandle();
      mockLiveRunRegistry.get = vi.fn().mockReturnValue(handle);

      const permPayload = { permissions: { network: true }, scope: "session" };
      await service.resumeWithAnswers({
        conversationId: "conversation-1",
        resumeRunId: "run-2",
        resume: [
          {
            interruptId: "int-1",
            status: "resolved",
            payload: permPayload,
          },
        ],
        res: makeRes(),
      });

      expect(mockRuntimeHost.command).toHaveBeenCalledWith(
        expect.objectContaining({
          runtimeHostId: "builtin",
          payload: expect.objectContaining({
            type: "approval_resolved",
            runId: "run-1",
            payload: permPayload,
          }),
        })
      );
    });
  });

  describe("listRawEventsForAdmin()", () => {
    it("returns an empty page when the run has no conversation", async () => {
      mockRunRepository.findConversationId = vi.fn().mockResolvedValue(null);

      const result = await service.listRawEventsForAdmin({
        runId: "run-1",
        take: 10,
        skip: 0,
      });

      expect(result).toEqual({ list: [], total: 0, pageNo: 1, pageSize: 10 });
    });

    it("resolves conversationId then delegates to RunEventService", async () => {
      mockRunRepository.findConversationId = vi
        .fn()
        .mockResolvedValue("conversation-1");
      const listRawForAdmin = vi
        .spyOn(mockRunEvents, "listRawForAdmin")
        .mockReturnValue({ list: [], total: 0, pageNo: 1, pageSize: 10 });

      await service.listRawEventsForAdmin({
        runId: "run-1",
        channel: ["sdk.raw"],
        take: 10,
        skip: 0,
      });

      expect(mockRunRepository.findConversationId).toHaveBeenCalledWith(
        "run-1"
      );
      expect(listRawForAdmin).toHaveBeenCalledWith({
        runId: "run-1",
        channel: ["sdk.raw"],
        take: 10,
        skip: 0,
        conversationId: "conversation-1",
      });
    });
  });

  describe("stop()", () => {
    it("should mark cancelled and return false when no live handle but run record exists", async () => {
      mockRunRepository.findActiveByConversationId = vi
        .fn()
        .mockResolvedValue({ id: "run-1" });
      mockLiveRunRegistry.get = vi.fn().mockReturnValue(undefined);

      const hadHandle = await service.stop("conversation-1");

      expect(
        mockRunStatusService.markCancelledWithoutHandle
      ).toHaveBeenCalledWith("run-1");
      expect(hadHandle).toBe(false);
    });

    it("should cancel and return true when an live handle exists", async () => {
      mockRunRepository.findActiveByConversationId = vi
        .fn()
        .mockResolvedValue({ id: "run-1" });
      const handle = {
        runtimeHandle: {
          runId: "run-1",
          runtimeHostId: "builtin",
          runtimeType: "native",
          conversationId: "conversation-1",
        },
        stopRequested: false,
      };
      mockLiveRunRegistry.get = vi.fn().mockReturnValue(handle);

      const hadHandle = await service.stop("conversation-1");

      expect(mockRunStatusService.markCancelRequested).toHaveBeenCalledWith(
        "run-1",
        undefined
      );
      expect(mockRuntimeHost.command).toHaveBeenCalledWith(
        expect.objectContaining({
          runtimeHostId: "builtin",
          payload: expect.objectContaining({
            type: "cancel",
            runId: "run-1",
            conversationId: "conversation-1",
          }),
        })
      );
      expect(hadHandle).toBe(true);
    });
  });

  describe("resume()", () => {
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

      await service.resume("conversation-1", res);

      const writes = (res.write as ReturnType<typeof vi.fn>).mock.calls.map(
        (c) => c[0] as string
      );
      expect(writes.length).toBeGreaterThan(0);
      const last = JSON.parse(writes.at(-1)!.slice(6).trim());
      expect(last.status).toEqual({ type: "complete", reason: "unknown" });
      expect(res.end).toHaveBeenCalled();
    });

    it("requires_action 的 run 发当前累积快照(含待答状态)后收尾,不接 stream", async () => {
      mockRunRepository.findActiveByConversationId = vi
        .fn()
        .mockResolvedValue({ id: "run-1", status: "requires_action" });
      const snapshot = {
        content: [],
        status: { type: "requires-action", reason: "interrupt" },
      };
      mockLiveRunRegistry.get = vi.fn().mockReturnValue({
        runId: "run-1",
        aggregator: { build: vi.fn().mockReturnValue(snapshot) },
      });
      const res = {
        setHeader: vi.fn(),
        write: vi.fn(),
        end: vi.fn(),
        writableEnded: false,
        on: vi.fn(),
        status: vi.fn().mockReturnThis(),
      } as any;

      await service.resume("conversation-1", res);

      expect(res.status).not.toHaveBeenCalledWith(409);
      expect(res.write).toHaveBeenCalledWith(
        expect.stringContaining("requires-action")
      );
      expect(res.end).toHaveBeenCalled();
    });
  });
});
