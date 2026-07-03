import { describe, it, expect, vi } from "vitest";
import { RunRecoveryService } from "./run-recovery.service";
import { RunRepository } from "../run.repository";
import { ConversationService } from "../../conversation/conversation.service";
import { WorkerManagerService } from "../../worker-manager/worker-manager.service";

function makeWorkerManager(
  overrides: Record<string, unknown> = {}
): Partial<WorkerManagerService> {
  return {
    findRuntimeByRuntimeId: vi.fn().mockResolvedValue(null),
    sendCommand: vi.fn(),
    ...overrides,
  };
}

describe("RunRecoveryService.failInterruptedRuns", () => {
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
    const workerManager = makeWorkerManager({
      findRuntimeByRuntimeId: vi.fn().mockResolvedValue({ ownerId: "ws-1" }),
    });

    const service = new RunRecoveryService(
      mockRunRepository as RunRepository,
      mockConversations as ConversationService,
      workerManager as WorkerManagerService
    );

    await service.failInterruptedRuns();

    expect(workerManager.findRuntimeByRuntimeId).toHaveBeenCalledWith(
      "sandbox",
      "container-abc"
    );
    expect(workerManager.sendCommand).toHaveBeenCalledWith(
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
    const workerManager = makeWorkerManager();

    const service = new RunRecoveryService(
      mockRunRepository as RunRepository,
      mockConversations as ConversationService,
      workerManager as WorkerManagerService
    );

    await service.failInterruptedRuns();

    expect(workerManager.findRuntimeByRuntimeId).not.toHaveBeenCalled();
    expect(workerManager.sendCommand).not.toHaveBeenCalled();
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
          runtimeType: "sandbox",
          runtimeInstanceId: "container-xyz",
        },
      ]),
      markError: vi.fn().mockResolvedValue(undefined),
    };
    const mockConversations: Partial<ConversationService> = {
      setRunStatus: vi.fn().mockResolvedValue(undefined),
    };
    const workerManager = makeWorkerManager({
      findRuntimeByRuntimeId: vi.fn().mockResolvedValue(null),
    });

    const service = new RunRecoveryService(
      mockRunRepository as RunRepository,
      mockConversations as ConversationService,
      workerManager as WorkerManagerService
    );

    await service.failInterruptedRuns();

    expect(workerManager.findRuntimeByRuntimeId).toHaveBeenCalledWith(
      "sandbox",
      "container-xyz"
    );
    expect(workerManager.sendCommand).not.toHaveBeenCalled();
    expect(mockRunRepository.markError).toHaveBeenCalledWith(
      "run-1",
      "服务重启导致运行中断"
    );
  });

  it("skips the cancel command for a local runtime even when an instance is bound (lifecycle already reaped it)", async () => {
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
    const workerManager = makeWorkerManager({
      findRuntimeByRuntimeId: vi.fn().mockResolvedValue({ ownerId: "ws-1" }),
    });

    const service = new RunRecoveryService(
      mockRunRepository as RunRepository,
      mockConversations as ConversationService,
      workerManager as WorkerManagerService
    );

    await service.failInterruptedRuns();

    // local 分支在查 WorkerRegistry 之前就早退,连 findRuntimeByRuntimeId 都不该调。
    expect(workerManager.findRuntimeByRuntimeId).not.toHaveBeenCalled();
    expect(workerManager.sendCommand).not.toHaveBeenCalled();
    expect(mockRunRepository.markError).toHaveBeenCalledWith(
      "run-1",
      "服务重启导致运行中断"
    );
  });
});
