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
import { ExecutionService } from "./execution/execution.service";
import { WorkerRunExecutor } from "./execution/worker-run.executor";
import { RunService } from "./run.service";
import { WorkerEventService } from "./worker-event/worker-event.service";
import { WorkerHostService } from "../worker-host/worker-host.service";
import { WorkerRegistryRepository } from "../worker-host/registry/worker-registry.repository";
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
  let runRecovery: { recoverInterruptedRuns: ReturnType<typeof vi.fn> };

  afterEach(async () => {
    await testingModule?.close();
    testingModule = undefined;
    vi.restoreAllMocks();
  });

  it("compiles, resolves run executor tokens, and wires startup provider hooks", async () => {
    ({ testingModule, runRecovery } = await createRunsTestingModule([
      RunModule,
    ]));

    expect(testingModule.get(WorkerRunExecutor)).toBeInstanceOf(
      WorkerRunExecutor
    );
    expect(testingModule.get(RunService)).toBeInstanceOf(RunService);

    const executionService = testingModule.get(ExecutionService);
    expect(testingModule.get(RunStartupService)).toBeInstanceOf(
      RunStartupService
    );
    const setRunEventPort = vi.spyOn(executionService, "setRunEventPort");
    const workerHost = testingModule.get(WorkerHostService);
    const setUpstreamPort = vi.spyOn(workerHost, "setUpstreamPort");
    const liveRuns = testingModule.get(LiveRunRegistry);
    const setTimeoutErrorPort = vi.spyOn(liveRuns, "setTimeoutErrorPort");
    await testingModule.init();

    const workerEvents = testingModule.get(WorkerEventService);
    expect(setRunEventPort).toHaveBeenCalledWith(workerEvents);
    expect(setUpstreamPort).toHaveBeenCalledWith(workerEvents);
    expect(setTimeoutErrorPort).toHaveBeenCalledWith(workerEvents);
    // run 自身在 onApplicationBootstrap 触发一次性重启恢复（不再依赖反向端口接线）
    expect(runRecovery.recoverInterruptedRuns).toHaveBeenCalledTimes(1);
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
  runRecovery: { recoverInterruptedRuns: ReturnType<typeof vi.fn> };
}> {
  const recovery = {
    recoverInterruptedRuns: vi.fn().mockResolvedValue(undefined),
  };
  const module = await Test.createTestingModule({
    imports: [ConfigModule, PrismaModule, ...(runImports ?? [])],
  })
    .overrideProvider(ConfigService)
    .useValue(createConfigServiceMock())
    .overrideProvider(PrismaService)
    .useValue({})
    .overrideProvider(ModelProviderService)
    .useValue({})
    .overrideProvider(RunRecoveryService)
    .useValue(recovery)
    // RuntimeInstanceLifecycleService.onApplicationBootstrap（worker-host 模块内）
    // 现在也在 init() 时触发,会经 WorkerRegistryRepository 打真实 Prisma;这里的
    // PrismaService 是空对象 mock,所以同样要挡住,跟上面 RunRecoveryService 的
    // override 是同一个原因。
    .overrideProvider(WorkerRegistryRepository)
    .useValue({
      markAllStartingAsError: vi.fn().mockResolvedValue(undefined),
      findRunningByRuntimeType: vi.fn().mockResolvedValue([]),
    })
    .compile();

  return { testingModule: module, runRecovery: recovery };
}

function createConfigServiceMock(): Partial<ConfigService> {
  return {
    getDefaultRuntimeType: vi.fn().mockReturnValue("local"),
    getDefaultIsolationScope: vi.fn().mockReturnValue("workspace"),
    getSandboxEngine: vi.fn().mockReturnValue("docker"),
    getRuntimeLogDir: vi.fn().mockReturnValue("/tmp/agework-runtime-logs"),
    getIdleTimeoutSeconds: vi.fn().mockReturnValue(600),
    getRunTimeoutSeconds: vi.fn().mockReturnValue(120),
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
