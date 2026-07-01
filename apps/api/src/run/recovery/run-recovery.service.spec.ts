import { describe, it, expect, vi } from "vitest";
import { RunRecoveryService } from "./run-recovery.service";
import { RunRepository } from "../run.repository";
import { ConversationService } from "../../conversation/conversation.service";
import { RuntimeService } from "../../runtime/runtime.service";
import { ExecutionService } from "../execution/execution.service";

function makeRuntimeService(
  overrides: Record<string, unknown> = {}
): Partial<RuntimeService> {
  return {
    isRuntimeInstanceUserScoped: vi.fn().mockResolvedValue(false),
    ...overrides,
  };
}

describe("RunRecoveryService.recoverInterruptedRuns", () => {
  it("cleans up interrupted runs through the execution service", async () => {
    const mockRunRepository: Partial<RunRepository> = {
      findAllActive: vi.fn().mockResolvedValue([
        {
          id: "run-1",
          conversationId: "conversation-1",
          runtimeType: "docker",
          runtimeInstanceId: "container-abc",
        },
      ]),
      markError: vi.fn().mockResolvedValue(undefined),
    };
    const mockConversations: Partial<ConversationService> = {
      setRunStatus: vi.fn().mockResolvedValue(undefined),
    };
    const mockExecutionService: Partial<ExecutionService> = {
      cleanupInterruptedExecution: vi.fn().mockResolvedValue(undefined),
    };
    const runtimeService = makeRuntimeService();

    const service = new RunRecoveryService(
      mockRunRepository as RunRepository,
      mockConversations as ConversationService,
      mockExecutionService as ExecutionService,
      runtimeService as RuntimeService
    );

    await service.recoverInterruptedRuns();

    expect(runtimeService.isRuntimeInstanceUserScoped).toHaveBeenCalledWith(
      "docker",
      "container-abc"
    );
    expect(
      mockExecutionService.cleanupInterruptedExecution
    ).toHaveBeenCalledWith("docker", "container-abc");
    expect(mockRunRepository.markError).toHaveBeenCalledWith(
      "run-1",
      "服务重启导致运行中断"
    );
    expect(mockConversations.setRunStatus).toHaveBeenCalledWith(
      "conversation-1",
      "error"
    );
  });

  it("skips interrupted execution cleanup when a run has no persisted runtimeInstanceId", async () => {
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
    const mockExecutionService: Partial<ExecutionService> = {
      cleanupInterruptedExecution: vi.fn(),
    };
    const runtimeService = makeRuntimeService();

    const service = new RunRecoveryService(
      mockRunRepository as RunRepository,
      mockConversations as ConversationService,
      mockExecutionService as ExecutionService,
      runtimeService as RuntimeService
    );

    await service.recoverInterruptedRuns();

    expect(
      mockExecutionService.cleanupInterruptedExecution
    ).not.toHaveBeenCalled();
    expect(mockRunRepository.markError).toHaveBeenCalledWith(
      "run-1",
      "服务重启导致运行中断"
    );
  });

  it("skips interrupted execution cleanup for user-scoped runtime resources", async () => {
    const mockRunRepository: Partial<RunRepository> = {
      findAllActive: vi.fn().mockResolvedValue([
        {
          id: "run-1",
          conversationId: "conversation-1",
          runtimeType: "sandbox",
          runtimeInstanceId: "container-user1",
        },
      ]),
      markError: vi.fn().mockResolvedValue(undefined),
    };
    const mockConversations: Partial<ConversationService> = {
      setRunStatus: vi.fn().mockResolvedValue(undefined),
    };
    const mockExecutionService: Partial<ExecutionService> = {
      cleanupInterruptedExecution: vi.fn(),
    };
    const runtimeService = makeRuntimeService({
      isRuntimeInstanceUserScoped: vi.fn().mockResolvedValue(true),
    });

    const service = new RunRecoveryService(
      mockRunRepository as RunRepository,
      mockConversations as ConversationService,
      mockExecutionService as ExecutionService,
      runtimeService as RuntimeService
    );

    await service.recoverInterruptedRuns();

    expect(
      mockExecutionService.cleanupInterruptedExecution
    ).not.toHaveBeenCalled();
    // 即便跳过运行清理，run 仍标记为 error
    expect(mockRunRepository.markError).toHaveBeenCalledWith(
      "run-1",
      "服务重启导致运行中断"
    );
  });
});
