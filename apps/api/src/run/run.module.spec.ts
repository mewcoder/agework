import { Injectable, Module } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigModule } from "../config/config.module";
import { ConfigService } from "../config/config.service";
import { ModelProviderService } from "../model-provider/model-provider.service";
import { PrismaModule } from "../prisma/prisma.module";
import { PrismaService } from "../prisma/prisma.service";
import { RuntimeProviderRegistry } from "../runtime/providers/provider-registry";
import { LiveRunRegistry } from "./live-run/live-run.registry";
import { RunRecoveryService } from "./recovery/run-recovery.service";
import {
  RUN_EXECUTORS,
  RunExecutorRegistry,
} from "./execution/executor.registry";
import type { RunExecutor } from "./execution/executor";
import { ExecutionService } from "./execution/execution.service";
import { RunService } from "./run.service";
import { WorkerEventService } from "./worker-event/worker-event.service";
import { WorkerHostService } from "../worker-host/worker-host.service";
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

    const executors = testingModule.get<RunExecutor[]>(RUN_EXECUTORS);
    expect(executors.map((executor) => executor.type)).toEqual([
      "local",
      "sandbox",
    ]);

    const executorRegistry = testingModule.get(RunExecutorRegistry);
    expect(executorRegistry.resolve("local")).toBe(executors[0]);
    expect(executorRegistry.resolve("sandbox")).toBe(executors[1]);
    expect(testingModule.get(RunService)).toBeInstanceOf(RunService);

    const executionService = testingModule.get(ExecutionService);
    expect(testingModule.get(RunStartupService)).toBeInstanceOf(
      RunStartupService
    );
    const setRunEventReceiver = vi.spyOn(
      executionService,
      "setRunEventReceiver"
    );
    const workerHost = testingModule.get(WorkerHostService);
    const setCommandSentPort = vi.spyOn(
      workerHost,
      "setCommandSentPort"
    );
    const setUpstreamPort = vi.spyOn(workerHost, "setUpstreamPort");
    const liveRuns = testingModule.get(LiveRunRegistry);
    const setTimeoutErrorSink = vi.spyOn(liveRuns, "setTimeoutErrorSink");
    const runtimeProviderRegistry = testingModule.get(RuntimeProviderRegistry);
    const sandboxProvider = runtimeProviderRegistry.resolve("sandbox");
    const setOwnerSessionCleanup = vi.spyOn(
      sandboxProvider,
      "setOwnerSessionCleanup"
    );

    await testingModule.init();

    const workerEvents = testingModule.get(WorkerEventService);
    expect(setRunEventReceiver).toHaveBeenCalledWith(workerEvents);
    expect(setCommandSentPort).toHaveBeenCalledWith(workerEvents);
    expect(setUpstreamPort).toHaveBeenCalledWith(workerEvents);
    expect(setTimeoutErrorSink).toHaveBeenCalledWith(workerEvents);
    expect(setOwnerSessionCleanup).toHaveBeenCalledWith(expect.any(Function));
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
