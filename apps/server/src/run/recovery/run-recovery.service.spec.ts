import { describe, it, expect, vi } from "vitest";
import type { RuntimeHostContract } from "@agework/shared/protocol";
import { RunRecoveryService } from "./run-recovery.service";
import { RunRepository } from "../run.repository";
import type { ConversationService } from "../../conversation/conversation.service";

function makeRuntimeHost(
  overrides: Record<string, unknown> = {}
): Partial<RuntimeHostContract> {
  return {
    sendRecoveryCancel: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("RunRecoveryService.failInterruptedRuns", () => {
  it("sends a recovery cancel through the contract instead of tearing the instance down", async () => {
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
    const mockConversationEffects: Partial<ConversationService> = {
      setConversationRunState: vi.fn().mockResolvedValue(undefined),
    };
    const runtimeHost = makeRuntimeHost();

    const service = new RunRecoveryService(
      mockRunRepository as RunRepository,
      mockConversationEffects as unknown as ConversationService,
      runtimeHost as RuntimeHostContract
    );

    await service.failInterruptedRuns();

    expect(runtimeHost.sendRecoveryCancel).toHaveBeenCalledWith({
      runId: "run-1",
      conversationId: "conversation-1",
      ref: { runtimeType: "sandbox", runtimeInstanceId: "container-abc" },
    });
    expect(mockRunRepository.markError).toHaveBeenCalledWith(
      "run-1",
      "服务重启导致运行中断"
    );
    expect(
      mockConversationEffects.setConversationRunState
    ).toHaveBeenCalledWith("conversation-1", { runStatus: "error" });
  });

  it("skips the recovery cancel when a run has no persisted runtimeInstanceId", async () => {
    const mockRunRepository: Partial<RunRepository> = {
      findAllActive: vi.fn().mockResolvedValue([
        {
          id: "run-1",
          conversationId: "conversation-1",
          runtimeType: "native",
          runtimeInstanceId: null,
        },
      ]),
      markError: vi.fn().mockResolvedValue(undefined),
    };
    const mockConversationEffects: Partial<ConversationService> = {
      setConversationRunState: vi.fn().mockResolvedValue(undefined),
    };
    const runtimeHost = makeRuntimeHost();

    const service = new RunRecoveryService(
      mockRunRepository as RunRepository,
      mockConversationEffects as unknown as ConversationService,
      runtimeHost as RuntimeHostContract
    );

    await service.failInterruptedRuns();

    expect(runtimeHost.sendRecoveryCancel).not.toHaveBeenCalled();
    expect(mockRunRepository.markError).toHaveBeenCalledWith(
      "run-1",
      "服务重启导致运行中断"
    );
  });

  it("still marks the run as error when the recovery cancel rejects", async () => {
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
    const mockConversationEffects: Partial<ConversationService> = {
      setConversationRunState: vi.fn().mockResolvedValue(undefined),
    };
    const runtimeHost = makeRuntimeHost({
      sendRecoveryCancel: vi.fn().mockRejectedValue(new Error("boom")),
    });

    const service = new RunRecoveryService(
      mockRunRepository as RunRepository,
      mockConversationEffects as unknown as ConversationService,
      runtimeHost as RuntimeHostContract
    );

    await service.failInterruptedRuns();

    expect(mockRunRepository.markError).toHaveBeenCalledWith(
      "run-1",
      "服务重启导致运行中断"
    );
  });
});
