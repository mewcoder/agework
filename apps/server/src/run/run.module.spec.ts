import { Injectable, Module } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
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
    imports: [ConfigModule, PrismaModule, ...(runImports ?? [])],
  })
    .overrideProvider(ConfigService)
    .useValue(createConfigServiceMock())
    .overrideProvider(PrismaService)
    // RuntimeInstanceLifecycleService.onApplicationBootstrap（worker-manager 模块内）
    // 在 init() 时经 WorkerRegistryRepository 做重启扫尾，这里给对应查询空实现。
    .useValue({
      workerInstance: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        findMany: vi.fn().mockResolvedValue([]),
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
    getDefaultRuntimeType: vi.fn().mockReturnValue("local"),
    getDefaultIsolationScope: vi.fn().mockReturnValue("workspace"),
    getRuntimeLogDir: vi.fn().mockReturnValue("/tmp/agework-runtime-logs"),
    getIdleTimeoutSeconds: vi.fn().mockReturnValue(600),
    getRunTimeoutSeconds: vi.fn().mockReturnValue(120),
    getHeartbeatCheckIntervalSeconds: vi.fn().mockReturnValue(20),
    getHeartbeatTimeoutSeconds: vi.fn().mockReturnValue(75),
    getOpenSandboxConfig: vi.fn().mockReturnValue({
      domain: "opensandbox.test",
      protocol: "https",
      apiKey: "test-key",
      image: "agework-worker:test",
      timeoutSeconds: 300,
      useServerProxy: false,
    }),
  };
}
