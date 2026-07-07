import { Global, Injectable, Module } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { EventEmitterModule } from "@nestjs/event-emitter";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigModule } from "../config/config.module";
import { ConfigService } from "../config/config.service";
import { ModelProviderService } from "../model-provider/model-provider.service";
import { PrismaModule } from "../prisma/prisma.module";
import { PrismaService } from "../prisma/prisma.service";
import { LiveRunRegistry } from "./live-run/live-run.registry";
import { RunRecoveryService } from "./recovery/run-recovery.service";
import { RunDriver } from "./driver/run-driver";
import { RunService } from "./run.service";
import { WorkerEventService } from "./upstream/worker-event.service";
import { WorkerManagerService } from "../worker-manager/worker-manager.service";
import { RunModule } from "./run.module";
import { RunStartupService } from "./startup/run-startup.service";
import { CONVERSATION_EFFECTS_PORT } from "./run.types";

const MOCK_CONVERSATION_EFFECTS = {
  activateConversation: vi.fn().mockResolvedValue(true),
  setConversationRunState: vi.fn().mockResolvedValue(undefined),
  persistConversationMessage: vi.fn().mockResolvedValue(undefined),
};

/**
 * Global module providing CONVERSATION_EFFECTS_PORT mock for RunModule DI.
 * Must be @Global() so RunModule's encapsulated providers can resolve the Symbol token.
 */
@Global()
@Module({
  providers: [
    { provide: CONVERSATION_EFFECTS_PORT, useValue: MOCK_CONVERSATION_EFFECTS },
  ],
  exports: [CONVERSATION_EFFECTS_PORT],
})
class ConversationEffectsPortModule {}

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

  it("compiles, resolves run executor tokens, and wires startup provider hooks", async () => {
    ({ testingModule, runRecovery } = await createRunsTestingModule([
      RunModule,
    ]));

    const runDriver = testingModule.get(RunDriver);
    expect(runDriver).toBeInstanceOf(RunDriver);
    expect(testingModule.get(RunService)).toBeInstanceOf(RunService);

    expect(testingModule.get(RunStartupService)).toBeInstanceOf(
      RunStartupService
    );
    const setRunEventPort = vi.spyOn(runDriver, "setRunEventPort");
    const workerManager = testingModule.get(WorkerManagerService);
    const setUpstreamPort = vi.spyOn(workerManager, "setUpstreamPort");
    const liveRuns = testingModule.get(LiveRunRegistry);
    const setTimeoutErrorPort = vi.spyOn(liveRuns, "setTimeoutErrorPort");
    await testingModule.init();

    const workerEvents = testingModule.get(WorkerEventService);
    expect(setRunEventPort).toHaveBeenCalledWith(workerEvents);
    expect(setUpstreamPort).toHaveBeenCalledWith(workerEvents);
    expect(setTimeoutErrorPort).toHaveBeenCalledWith(workerEvents);
    // run 自身在 onApplicationBootstrap 触发一次性重启恢复（不再依赖反向端口接线）
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
      ConversationEffectsPortModule,
      ...(runImports ?? []),
    ],
  })
    .overrideProvider(ConfigService)
    .useValue(createConfigServiceMock())
    .overrideProvider(PrismaService)
    // WorkerLifecycleHandler.onApplicationBootstrap（worker-manager 模块内）在
    // init() 时经 WorkerRegistryRepository 做重启扫尾;RuntimeService.onApplicationBootstrap
    // 同时 upsert builtin Runtime 行——这里给对应查询空实现。
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
    getAllowedRuntimeTypes: () => ["local"],
    getDefaultRuntimeType: () => "local",
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
