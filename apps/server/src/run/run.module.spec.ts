import { Injectable, Module } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { EventEmitterModule } from "@nestjs/event-emitter";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigModule } from "../config/config.module";
import { ConfigService } from "../config/config.service";
import { ConversationService } from "../conversation/conversation.service";
import { ModelProviderService } from "../model-provider/model-provider.service";
import { PrismaModule } from "../prisma/prisma.module";
import { PrismaService } from "../prisma/prisma.service";
import { LiveRunRegistry } from "./live-run/live-run.registry";
import { RunRecoveryService } from "./recovery/run-recovery.service";
import { RunService } from "./run.service";
import { WorkerEventService } from "./upstream/worker-event.service";
import { RuntimeHostAdapter } from "../worker-manager/contract/runtime-host.adapter";
import { RunModule } from "./run.module";

const MOCK_CONVERSATION_SERVICE = {
  activateConversation: vi.fn().mockResolvedValue(true),
  setConversationRunState: vi.fn().mockResolvedValue(undefined),
  saveUserMessage: vi.fn().mockResolvedValue(undefined),
  saveAssistantMessage: vi.fn().mockResolvedValue(undefined),
  attachMessageToRun: vi.fn().mockResolvedValue(undefined),
  setAgentSessionId: vi.fn().mockResolvedValue(undefined),
};

@Injectable()
class DownstreamRunConsumer {
  constructor(readonly runService: RunService) {}
}

@Module({
  imports: [RunModule],
  providers: [DownstreamRunConsumer],
})
class DownstreamRunConsumerModule {}

describe("RunModule wiring", () => {
  let testingModule: TestingModule | undefined;
  let runRecovery: { failInterruptedRuns: ReturnType<typeof vi.fn> };

  afterEach(async () => {
    await testingModule?.close();
    testingModule = undefined;
    vi.restoreAllMocks();
  });

  it("compiles, resolves the runtime host contract, and self-wires the upstream on init", async () => {
    ({ testingModule, runRecovery } = await createRunsTestingModule([
      RunModule,
    ]));

    expect(testingModule.get(RunService)).toBeInstanceOf(RunService);

    const adapter = testingModule.get(RuntimeHostAdapter);
    const setUpstream = vi.spyOn(adapter, "setUpstream");
    const liveRuns = testingModule.get(LiveRunRegistry);
    const setTimeoutErrorPort = vi.spyOn(liveRuns, "setTimeoutErrorPort");
    await testingModule.init();

    const workerEvents = testingModule.get(WorkerEventService);
    expect(setUpstream).toHaveBeenCalledWith(workerEvents);
    expect(setTimeoutErrorPort).toHaveBeenCalledWith(workerEvents);
    // run 自身在 onApplicationBootstrap 触发一次性重启恢复
    expect(runRecovery.failInterruptedRuns).toHaveBeenCalledTimes(1);
  });

  it("exports RunService to downstream modules", async () => {
    ({ testingModule } = await createRunsTestingModule([
      DownstreamRunConsumerModule,
    ]));

    const consumer = testingModule.get(DownstreamRunConsumer);
    expect(consumer.runService).toBe(testingModule.get(RunService));
  });
});

async function createRunsTestingModule(
  runImports: Parameters<typeof Test.createTestingModule>[0]["imports"]
): Promise<{
  testingModule: TestingModule;
  runRecovery: { failInterruptedRuns: ReturnType<typeof vi.fn> };
}> {
  const recovery = {
    failInterruptedRuns: vi.fn().mockResolvedValue(undefined),
  };
  const module = await Test.createTestingModule({
    imports: [
      ConfigModule,
      PrismaModule,
      EventEmitterModule.forRoot(),
      ...(runImports ?? []),
    ],
  })
    .overrideProvider(ConfigService)
    .useValue(createConfigServiceMock())
    .overrideProvider(PrismaService)
    .useValue({
      worker: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        findMany: vi.fn().mockResolvedValue([]),
      },
      runtime: {
        upsert: vi.fn().mockResolvedValue({}),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    })
    .overrideProvider(ModelProviderService)
    .useValue({})
    .overrideProvider(ConversationService)
    .useValue(MOCK_CONVERSATION_SERVICE)
    .overrideProvider(RunRecoveryService)
    .useValue(recovery)
    .compile();

  return { testingModule: module, runRecovery: recovery };
}

function createConfigServiceMock(): Partial<ConfigService> {
  return {
    getRunTimeoutSeconds: () => 60,
    getLaunchTimeoutSeconds: () => 30,
    getIdleTimeoutSeconds: () => 600,
    getHeartbeatTimeoutSeconds: () => 60,
    getHeartbeatCheckIntervalSeconds: () => 30,
    getAllowedRuntimeTypes: () => ["native"],
    getDefaultRuntimeType: () => "native",
    getRuntimeLogDir: () => "/tmp/agework-logs/runtime",
    getAgentEventTraceConfig: () => ({ enabled: false, maxFileMb: 5 }),
    getOpenSandboxConfig: () => ({
      domain: "localhost",
      protocol: "http",
      image: "test",
      timeoutSeconds: 30,
      useServerProxy: false,
    }),
  };
}
