import { describe, it, expect, vi } from "vitest";
import { RunRecoveryService } from "./run-recovery.service";
import { RunRepository } from "../run.repository";
import { ConversationService } from "../../conversation/conversation.service";
import { WorkerHostService } from "../../worker-host/worker-host.service";

function makeWorkerHost(
  overrides: Record<string, unknown> = {}
): Partial<WorkerHostService> {
  return {
    findRuntimeByRuntimeId: vi.fn().mockResolvedValue(null),
    sendCommand: vi.fn(),
    ...overrides,
  };
}

describe("RunRecoveryService.recoverInterruptedRuns", () => {
  it("sends a cancel command to the bound instance instead of tearing it down", async () => {
    const mockRunRepository: Partial<RunRepository> = {
      findAllActive: vi.fn().mockResolvedValue([
        {
          id: "run-1",
          conversationId: "conversation-1",
          runtimeType: "sandbox",
          runtimeInstanceId: "container-abc",
        },
      ]),
      markError: vi.fn().mockResolvedValue(undefined),
    };
    const mockConversations: Partial<ConversationService> = {
      setRunStatus: vi.fn().mockResolvedValue(undefined),
    };
    const workerHost = makeWorkerHost({
      findRuntimeByRuntimeId: vi.fn().mockResolvedValue({ ownerId: "ws-1" }),
    });

    const service = new RunRecoveryService(
      mockRunRepository as RunRepository,
      mockConversations as ConversationService,
      workerHost as WorkerHostService
    );

    await service.recoverInterruptedRuns();

    expect(workerHost.findRuntimeByRuntimeId).toHaveBeenCalledWith(
      "sandbox",
      "container-abc"
    );
    expect(workerHost.sendCommand).toHaveBeenCalledWith(
      "ws-1",
      "run-1",
      expect.objectContaining({
        type: "cancel",
        runId: "run-1",
        conversationId: "conversation-1",
      })
    );
    expect(mockRunRepository.markError).toHaveBeenCalledWith(
      "run-1",
      "服务重启导致运行中断"
    );
    expect(mockConversations.setRunStatus).toHaveBeenCalledWith(
      "conversation-1",
      "error"
    );
  });

  it("skips sending a cancel command when a run has no persisted runtimeInstanceId", async () => {
    const mockRunRepository: Partial<RunRepository> = {
      findAllActive: vi.fn().mockResolvedValue([
        {
          id: "run-1",
          conversationId: "conversation-1",
          runtimeType: "local",
          runtimeInstanceId: null,
        },
      ]),
      markError: vi.fn().mockResolvedValue(undefined),
    };
    const mockConversations: Partial<ConversationService> = {
      setRunStatus: vi.fn().mockResolvedValue(undefined),
    };
    const workerHost = makeWorkerHost();

    const service = new RunRecoveryService(
      mockRunRepository as RunRepository,
      mockConversations as ConversationService,
      workerHost as WorkerHostService
    );

    await service.recoverInterruptedRuns();

    expect(workerHost.findRuntimeByRuntimeId).not.toHaveBeenCalled();
    expect(workerHost.sendCommand).not.toHaveBeenCalled();
    expect(mockRunRepository.markError).toHaveBeenCalledWith(
      "run-1",
      "服务重启导致运行中断"
    );
  });

  it("skips sending a cancel command when no WorkerRegistry row is found for the instance", async () => {
    const mockRunRepository: Partial<RunRepository> = {
      findAllActive: vi.fn().mockResolvedValue([
        {
          id: "run-1",
          conversationId: "conversation-1",
          runtimeType: "local",
          runtimeInstanceId: "4242:token",
        },
      ]),
      markError: vi.fn().mockResolvedValue(undefined),
    };
    const mockConversations: Partial<ConversationService> = {
      setRunStatus: vi.fn().mockResolvedValue(undefined),
    };
    const workerHost = makeWorkerHost({
      findRuntimeByRuntimeId: vi.fn().mockResolvedValue(null),
    });

    const service = new RunRecoveryService(
      mockRunRepository as RunRepository,
      mockConversations as ConversationService,
      workerHost as WorkerHostService
    );

    await service.recoverInterruptedRuns();

    expect(workerHost.sendCommand).not.toHaveBeenCalled();
    expect(mockRunRepository.markError).toHaveBeenCalledWith(
      "run-1",
      "服务重启导致运行中断"
    );
  });
});
