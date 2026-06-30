import { describe, it, expect, vi, beforeEach } from "vitest";
import { RunService } from "./run.service";
import { RunRepository } from "./run.repository";
import { LiveRunRegistry } from "./live-run/live-run.registry";
import { ExecutionService } from "./execution/execution.service";
import { RunEventService } from "../run-event/run-event.service";
import { RunLauncher } from "./launch/run-launcher";
import { RuntimeService } from "../runtime/runtime.service";
import { RunRecoveryService } from "./recovery/run-recovery.service";

describe("RunService", () => {
  let service: RunService;
  let mockRunRepository: Partial<RunRepository>;
  let mockLiveRunRegistry: Partial<LiveRunRegistry>;
  let mockExecutionService: Partial<ExecutionService>;
  let mockRunEvents: RunEventService;
  let mockRunLauncher: Partial<RunLauncher>;
  let mockRuntimeService: Partial<RuntimeService>;
  let mockRunRecovery: Partial<RunRecoveryService>;

  beforeEach(() => {
    mockRunRepository = {
      findActiveByConversationId: vi.fn().mockResolvedValue(null),
      markCancelling: vi.fn().mockResolvedValue(undefined),
      markCancelled: vi.fn().mockResolvedValue(undefined),
    };
    mockLiveRunRegistry = {
      get: vi.fn().mockReturnValue(undefined),
    };
    mockExecutionService = {
      sendCommand: vi.fn(),
      cancel: vi.fn(),
    };
    mockRunEvents = new RunEventService({} as never);
    vi.spyOn(mockRunEvents, "append").mockResolvedValue({} as never);
    mockRunLauncher = {
      launch: vi.fn().mockResolvedValue(undefined),
    };
    mockRuntimeService = {
      getRuntimeInstanceForAdmin: vi.fn().mockResolvedValue(null),
    };
    mockRunRecovery = {
      recoverInterruptedRuns: vi.fn().mockResolvedValue(undefined),
    };

    service = new RunService(
      mockRunRepository as RunRepository,
      mockLiveRunRegistry as LiveRunRegistry,
      mockExecutionService as ExecutionService,
      mockRunEvents,
      mockRunLauncher as RunLauncher,
      mockRuntimeService as RuntimeService,
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

      expect(mockRunRecovery.recoverInterruptedRuns).toHaveBeenCalledTimes(1);
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

  describe("reply()", () => {
    it("should throw NotFoundException when no active run found", async () => {
      mockRunRepository.findActiveByConversationId = vi
        .fn()
        .mockResolvedValue(null);
      await expect(
        service.reply("conversation-1", {})
      ).rejects.toThrow();
    });

    it("should send approval control through worker execution when an live handle exists", async () => {
      mockRunRepository.findActiveByConversationId = vi
        .fn()
        .mockResolvedValue({ id: "run-1" });
      const handle = {
        runtimeHandle: {
          runId: "run-1",
          runtimeType: "local",
          runtimeInstanceId: "1:token",
          conversationId: "conversation-1",
        },
      };
      mockLiveRunRegistry.get = vi.fn().mockReturnValue(handle);

      await service.reply("conversation-1", { decision: "yes" });

      expect(mockExecutionService.sendCommand).toHaveBeenCalledWith(
        handle.runtimeHandle,
        expect.objectContaining({
          type: "approval_resolved",
          conversationId: "conversation-1",
          answers: { decision: "yes" },
        })
      );
    });
  });

  describe("stop()", () => {
    it("should mark cancelled and return false when no live handle but run record exists", async () => {
      mockRunRepository.findActiveByConversationId = vi
        .fn()
        .mockResolvedValue({ id: "run-1" });
      mockLiveRunRegistry.get = vi.fn().mockReturnValue(undefined);

      const hadHandle = await service.stop("conversation-1");

      expect(mockRunRepository.markCancelled).toHaveBeenCalledWith("run-1");
      expect(hadHandle).toBe(false);
    });

    it("should cancel and return true when an live handle exists", async () => {
      mockRunRepository.findActiveByConversationId = vi
        .fn()
        .mockResolvedValue({ id: "run-1" });
      const handle = {
        runtimeHandle: {
          runId: "run-1",
          runtimeType: "local",
          runtimeInstanceId: "1:token",
          conversationId: "conversation-1",
        },
        stopRequested: false,
      };
      mockLiveRunRegistry.get = vi.fn().mockReturnValue(handle);

      const hadHandle = await service.stop("conversation-1");

      expect(mockRunRepository.markCancelling).toHaveBeenCalledWith("run-1");
      expect(mockExecutionService.cancel).toHaveBeenCalledWith(
        handle.runtimeHandle
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

    it("requires_action 的 run 返回 409 不接 stream", async () => {
      mockRunRepository.findActiveByConversationId = vi
        .fn()
        .mockResolvedValue({ id: "run-1", status: "requires_action" });
      mockLiveRunRegistry.get = vi.fn().mockReturnValue({ runId: "run-1" });
      const res = {
        setHeader: vi.fn(),
        write: vi.fn(),
        end: vi.fn(),
        writableEnded: false,
        on: vi.fn(),
        status: vi.fn().mockReturnThis(),
      } as any;

      await service.resume("conversation-1", res);

      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.write).not.toHaveBeenCalled();
    });
  });
});
