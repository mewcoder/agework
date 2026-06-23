import { describe, it, expect, vi } from "vitest";
import { RunRecoveryUseCase } from "./run-recovery.use-case";
import { RunRepository } from "./run.repository";
import { ConversationService } from "../conversations/conversation.service";
import { RuntimeProviderRegistry } from "../runtime/providers/runtime-provider-registry";

function makePrisma() {
  return {
    runtimeResource: {
      findUnique: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  };
}

describe("RunRecoveryUseCase.recoverOrphanRuns", () => {
  it("recovers orphan runs via the matching provider's recoverOrphan, based on runtimeType", async () => {
    const recoverOrphan = vi.fn().mockResolvedValue(undefined);
    const mockRunRepository: Partial<RunRepository> = {
      findAllActive: vi.fn().mockResolvedValue([
        {
          id: "run-1",
          conversationId: "conversation-1",
          runtimeType: "docker",
          runtimeResourceId: "container-abc",
        },
      ]),
      markError: vi.fn().mockResolvedValue(undefined),
    };
    const mockConversationService: Partial<ConversationService> = {
      setActiveRunStatus: vi.fn().mockResolvedValue(undefined),
    };
    const mockProviderRegistry: Partial<RuntimeProviderRegistry> = {
      resolve: vi.fn().mockReturnValue({ recoverOrphan }),
    };

    const service = new RunRecoveryUseCase(
      mockRunRepository as RunRepository,
      mockConversationService as ConversationService,
      mockProviderRegistry as RuntimeProviderRegistry,
      makePrisma() as never
    );

    await service.recoverOrphanRuns();

    expect(mockProviderRegistry.resolve).toHaveBeenCalledWith("docker");
    expect(recoverOrphan).toHaveBeenCalledWith("container-abc");
    expect(mockRunRepository.markError).toHaveBeenCalledWith(
      "run-1",
      "服务重启导致运行中断"
    );
    expect(mockConversationService.setActiveRunStatus).toHaveBeenCalledWith(
      "conversation-1",
      "error"
    );
  });

  it("skips provider recovery when a run has no persisted runtimeResourceId", async () => {
    const mockRunRepository: Partial<RunRepository> = {
      findAllActive: vi.fn().mockResolvedValue([
        {
          id: "run-1",
          conversationId: "conversation-1",
          runtimeType: "local",
          runtimeResourceId: null,
        },
      ]),
      markError: vi.fn().mockResolvedValue(undefined),
    };
    const mockConversationService: Partial<ConversationService> = {
      setActiveRunStatus: vi.fn().mockResolvedValue(undefined),
    };
    const mockProviderRegistry: Partial<RuntimeProviderRegistry> = {
      resolve: vi.fn(),
    };

    const service = new RunRecoveryUseCase(
      mockRunRepository as RunRepository,
      mockConversationService as ConversationService,
      mockProviderRegistry as RuntimeProviderRegistry,
      makePrisma() as never
    );

    await service.recoverOrphanRuns();

    expect(mockProviderRegistry.resolve).not.toHaveBeenCalled();
    expect(mockRunRepository.markError).toHaveBeenCalledWith(
      "run-1",
      "服务重启导致运行中断"
    );
  });
});

describe("RunRecoveryUseCase.recoverOrphanContainers", () => {
  it("stops running workspace-scope runtime resources and marks them stopped", async () => {
    const recoverOrphan = vi.fn().mockResolvedValue(undefined);
    const mockRunRepository: Partial<RunRepository> = {
      findAllActive: vi.fn().mockResolvedValue([]),
    };
    const mockConversationService: Partial<ConversationService> = {};
    const mockProviderRegistry: Partial<RuntimeProviderRegistry> = {
      resolve: vi.fn().mockReturnValue({ recoverOrphan }),
    };
    const prisma = makePrisma();
    prisma.runtimeResource.findMany.mockResolvedValue([
      {
        id: "rr-1",
        runtimeType: "sandbox",
        isolationScope: "workspace",
        runtimeResourceId: "container-ws1",
      },
      {
        id: "rr-2",
        runtimeType: "sandbox",
        isolationScope: "workspace",
        runtimeResourceId: "container-ws2",
      },
    ]);

    const service = new RunRecoveryUseCase(
      mockRunRepository as RunRepository,
      mockConversationService as ConversationService,
      mockProviderRegistry as RuntimeProviderRegistry,
      prisma as never
    );

    await service.recoverOrphanRuns();

    expect(mockProviderRegistry.resolve).toHaveBeenCalledWith("sandbox");
    expect(recoverOrphan).toHaveBeenCalledWith("container-ws1");
    expect(recoverOrphan).toHaveBeenCalledWith("container-ws2");
    expect(prisma.runtimeResource.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["rr-1", "rr-2"] } },
      data: { status: "stopped" },
    });
  });

  it("skips user-scope runtime resources without stopping or marking them", async () => {
    const recoverOrphan = vi.fn().mockResolvedValue(undefined);
    const mockRunRepository: Partial<RunRepository> = {
      findAllActive: vi.fn().mockResolvedValue([]),
    };
    const mockConversationService: Partial<ConversationService> = {};
    const mockProviderRegistry: Partial<RuntimeProviderRegistry> = {
      resolve: vi.fn().mockReturnValue({ recoverOrphan }),
    };
    const prisma = makePrisma();
    prisma.runtimeResource.findMany.mockResolvedValue([
      {
        id: "rr-1",
        runtimeType: "sandbox",
        isolationScope: "user",
        runtimeResourceId: "container-user1",
      },
    ]);

    const service = new RunRecoveryUseCase(
      mockRunRepository as RunRepository,
      mockConversationService as ConversationService,
      mockProviderRegistry as RuntimeProviderRegistry,
      prisma as never
    );

    await service.recoverOrphanRuns();

    expect(recoverOrphan).not.toHaveBeenCalled();
    expect(prisma.runtimeResource.updateMany).not.toHaveBeenCalled();
  });
});
