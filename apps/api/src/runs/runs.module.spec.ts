import { Injectable, Module } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigModule } from "../config/config.module";
import { ConfigService } from "../config/config.service";
import { ModelProviderService } from "../model-providers/model-provider.service";
import { PrismaModule } from "../prisma/prisma.module";
import { PrismaService } from "../prisma/prisma.service";
import { RuntimeProviderRegistry } from "../runtime/providers/provider-registry";
import { LiveRunRegistry } from "./live-runs/live-run.registry";
import { RunRecoveryService } from "./recovery/run-recovery.service";
import {
  RUN_EXECUTORS,
  RunExecutorRegistry,
} from "./execution/executor.registry";
import type { RunExecutor } from "./execution/executor";
import { ExecutionService } from "./execution/execution.service";
import { RunService } from "./run.service";
import { WorkerEventsService } from "./worker-events/worker-events.service";
import { WorkerCommandQueue } from "../worker-host/command-queue";
import { WorkerUpstreamRegistry } from "../worker-host/worker-upstream.registry";
import { RunsModule } from "./runs.module";

@Injectable()
class DownstreamRunConsumer {
  constructor(readonly runService: RunService) {}
}

@Module({
  imports: [RunsModule],
  providers: [DownstreamRunConsumer],
})
class DownstreamRunConsumerModule {}

describe("RunsModule wiring", () => {
  let testingModule: TestingModule | undefined;
  let runRecovery: { recoverInterruptedRuns: ReturnType<typeof vi.fn> };

  afterEach(async () => {
    await testingModule?.close();
    testingModule = undefined;
    vi.restoreAllMocks();
  });

  it("compiles, resolves run executor tokens, and wires startup hooks", async () => {
    ({ testingModule, runRecovery } = await createRunsTestingModule([
      RunsModule,
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
    const setRunEventReceiver = vi.spyOn(
      executionService,
      "setRunEventReceiver"
    );
    const commandQueue = testingModule.get(WorkerCommandQueue);
    const setCommandSentRecorder = vi.spyOn(
      commandQueue,
      "setCommandSentRecorder"
    );
    const workerUpstream = testingModule.get(WorkerUpstreamRegistry);
    const setReceiver = vi.spyOn(workerUpstream, "setReceiver");
    const liveRuns = testingModule.get(LiveRunRegistry);
    const setTimeoutErrorSink = vi.spyOn(liveRuns, "setTimeoutErrorSink");
    const runtimeProviderRegistry = testingModule.get(RuntimeProviderRegistry);
    const sandboxProvider = runtimeProviderRegistry.resolve("sandbox");
    const setOwnerSessionCleanup = vi.spyOn(
      sandboxProvider,
      "setOwnerSessionCleanup"
    );

    await testingModule.init();

    const workerEvents = testingModule.get(WorkerEventsService);
    expect(setRunEventReceiver).toHaveBeenCalledWith(workerEvents);
    expect(setCommandSentRecorder).toHaveBeenCalledWith(workerEvents);
    expect(setReceiver).toHaveBeenCalledWith(workerEvents);
    expect(setTimeoutErrorSink).toHaveBeenCalledWith(workerEvents);
    expect(setOwnerSessionCleanup).toHaveBeenCalledWith(expect.any(Function));
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
