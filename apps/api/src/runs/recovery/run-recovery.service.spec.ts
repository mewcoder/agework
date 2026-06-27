import { describe, it, expect, vi } from "vitest";
import { RunRecoveryService } from "./run-recovery.service";
import { RunRepository } from "../run.repository";
import { RunConversationEffects } from "../conversation/run-conversation.effects";
import { RuntimeProviderRegistry } from "../../runtime/providers/provider-registry";
import { ExecutionService } from "../execution/execution.service";

function makePrisma() {
  return {
    runtimeInstance: {
      findUnique: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    user: {
      findFirst: vi.fn().mockResolvedValue({ id: "user-1" }),
    },
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
    const mockRunConversation: Partial<RunConversationEffects> = {
      markError: vi.fn().mockResolvedValue(undefined),
    };
    const mockExecutionService: Partial<ExecutionService> = {
      cleanupInterruptedExecution: vi.fn().mockResolvedValue(undefined),
    };
    const mockRuntimeProviderRegistry: Partial<RuntimeProviderRegistry> = {
      resolve: vi.fn(),
    };

    const service = new RunRecoveryService(
      mockRunRepository as RunRepository,
      mockRunConversation as RunConversationEffects,
      mockExecutionService as ExecutionService,
      mockRuntimeProviderRegistry as RuntimeProviderRegistry,
      makePrisma() as never
    );

    await service.recoverInterruptedRuns();

    expect(mockExecutionService.cleanupInterruptedExecution).toHaveBeenCalledWith(
      "docker",
      "container-abc"
    );
    expect(mockRunRepository.markError).toHaveBeenCalledWith(
      "run-1",
      "服务重启导致运行中断"
    );
    expect(mockRunConversation.markError).toHaveBeenCalledWith("conversation-1");
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
    const mockRunConversation: Partial<RunConversationEffects> = {
      markError: vi.fn().mockResolvedValue(undefined),
    };
    const mockExecutionService: Partial<ExecutionService> = {
      cleanupInterruptedExecution: vi.fn(),
    };
    const mockRuntimeProviderRegistry: Partial<RuntimeProviderRegistry> = {
      resolve: vi.fn(),
    };

    const service = new RunRecoveryService(
      mockRunRepository as RunRepository,
      mockRunConversation as RunConversationEffects,
      mockExecutionService as ExecutionService,
      mockRuntimeProviderRegistry as RuntimeProviderRegistry,
      makePrisma() as never
    );

    await service.recoverInterruptedRuns();

    expect(mockExecutionService.cleanupInterruptedExecution).not.toHaveBeenCalled();
    expect(mockRunRepository.markError).toHaveBeenCalledWith(
      "run-1",
      "服务重启导致运行中断"
    );
  });
});

describe("RunRecoveryService.recoverOrphanContainers", () => {
  it("stops running workspace-scope runtime resources and marks them stopped", async () => {
    const recoverOrphan = vi.fn().mockResolvedValue(undefined);
    const mockRunRepository: Partial<RunRepository> = {
      findAllActive: vi.fn().mockResolvedValue([]),
    };
    const mockRunConversation: Partial<RunConversationEffects> = {};
    const mockProviderRegistry: Partial<RuntimeProviderRegistry> = {
      resolve: vi.fn().mockReturnValue({ recoverOrphan }),
    };
    const mockExecutionService: Partial<ExecutionService> = {
      cleanupInterruptedExecution: vi.fn(),
    };
    const prisma = makePrisma();
    prisma.runtimeInstance.findMany.mockResolvedValue([
      {
        id: "rr-1",
        runtimeType: "sandbox",
        isolationScope: "workspace",
        ownerId: "ws-1",
        runtimeInstanceId: "container-ws1",
      },
      {
        id: "rr-2",
        runtimeType: "sandbox",
        isolationScope: "workspace",
        ownerId: "ws-2",
        runtimeInstanceId: "container-ws2",
      },
    ]);

    const service = new RunRecoveryService(
      mockRunRepository as RunRepository,
      mockRunConversation as RunConversationEffects,
      mockExecutionService as ExecutionService,
      mockProviderRegistry as RuntimeProviderRegistry,
      prisma as never
    );

    await service.recoverInterruptedRuns();

    expect(mockProviderRegistry.resolve).toHaveBeenCalledWith("sandbox");
    expect(recoverOrphan).toHaveBeenCalledWith("container-ws1");
    expect(recoverOrphan).toHaveBeenCalledWith("container-ws2");
    expect(prisma.runtimeInstance.update).toHaveBeenCalledWith({
      where: { id: "rr-1" },
      data: {
        status: "stopped",
        metadata: expect.objectContaining({
          ownerId: "ws-1",
          statusReason: "orphan_recovered",
          stoppedAt: expect.any(String),
        }),
      },
    });
    expect(prisma.runtimeInstance.update).toHaveBeenCalledWith({
      where: { id: "rr-2" },
      data: {
        status: "stopped",
        metadata: expect.objectContaining({
          ownerId: "ws-2",
          statusReason: "orphan_recovered",
          stoppedAt: expect.any(String),
        }),
      },
    });
  });

  it("marks legacy local runtime resources stopped without requiring a registered provider", async () => {
    const mockRunRepository: Partial<RunRepository> = {
      findAllActive: vi.fn().mockResolvedValue([]),
    };
    const mockRunConversation: Partial<RunConversationEffects> = {};
    const mockExecutionService: Partial<ExecutionService> = {
      cleanupInterruptedExecution: vi.fn(),
    };
    const prisma = makePrisma();
    prisma.runtimeInstance.findMany.mockResolvedValue([
      {
        id: "rr-local",
        runtimeType: "local",
        isolationScope: "workspace",
        ownerId: "ws-1",
        runtimeInstanceId: "12345:token",
      },
    ]);

    const service = new RunRecoveryService(
      mockRunRepository as RunRepository,
      mockRunConversation as RunConversationEffects,
      mockExecutionService as ExecutionService,
      new RuntimeProviderRegistry([]),
      prisma as never
    );

    await service.recoverInterruptedRuns();

    expect(prisma.runtimeInstance.update).toHaveBeenCalledWith({
      where: { id: "rr-local" },
      data: {
        status: "stopped",
        metadata: expect.objectContaining({
          runtimeType: "local",
          ownerId: "ws-1",
          statusReason: "orphan_recovered",
        }),
      },
    });
  });

  it("skips user-scope runtime resources without stopping or marking them", async () => {
    const recoverOrphan = vi.fn().mockResolvedValue(undefined);
    const mockRunRepository: Partial<RunRepository> = {
      findAllActive: vi.fn().mockResolvedValue([]),
    };
    const mockRunConversation: Partial<RunConversationEffects> = {};
    const mockProviderRegistry: Partial<RuntimeProviderRegistry> = {
      resolve: vi.fn().mockReturnValue({ recoverOrphan }),
    };
    const mockExecutionService: Partial<ExecutionService> = {
      cleanupInterruptedExecution: vi.fn(),
    };
    const prisma = makePrisma();
    prisma.runtimeInstance.findMany.mockResolvedValue([
      {
        id: "rr-1",
        runtimeType: "sandbox",
        isolationScope: "user",
        ownerId: "user-1",
        runtimeInstanceId: "container-user1",
      },
    ]);

    const service = new RunRecoveryService(
      mockRunRepository as RunRepository,
      mockRunConversation as RunConversationEffects,
      mockExecutionService as ExecutionService,
      mockProviderRegistry as RuntimeProviderRegistry,
      prisma as never
    );

    await service.recoverInterruptedRuns();

    expect(recoverOrphan).not.toHaveBeenCalled();
    expect(prisma.runtimeInstance.update).not.toHaveBeenCalled();
  });
});
