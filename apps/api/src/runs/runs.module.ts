import { Module, OnModuleInit } from "@nestjs/common";

// core
import { RunRepository } from "./run.repository";
import { LiveRunRegistry } from "./live-runs/live-run.registry";
import { WorkerEventsService } from "./worker-events/worker-events.service";
import { RunStatusService } from "./status/run-status.service";
import { RunRecoveryService } from "./recovery/run-recovery.service";
import { RunService } from "./run.service";
import { RunConversationEffects } from "./conversation/run-conversation.effects";
import { ExecutionService } from "./execution/execution.service";
import {
  RUN_EXECUTORS,
  RunExecutorRegistry,
} from "./execution/executor.registry";
import type { RunExecutor } from "./execution/executor";
import { LocalRunExecutor } from "./execution/local.executor";
import { SandboxRunExecutor } from "./execution/sandbox.executor";
import { WorkerAgUiEventHandler } from "./worker-events/agui-event.handler";

// controllers
import { AdminRunController } from "./admin/admin-run.controller";

// deps（向下依赖 runtime / worker-host，以及 conversation / model-provider 领域）
import { RuntimeModule } from "../runtime/runtime.module";
import { RuntimeProviderRegistry } from "../runtime/providers/provider-registry";
import { WorkerHostModule } from "../worker-host/worker-host.module";
import { WorkerCommandQueue } from "../worker-host/command-queue";
import { WorkerCommandDispatcher } from "../worker-host/command-dispatcher.service";
import { WorkerUpstreamRegistry } from "../worker-host/worker-upstream.registry";
import { ConversationModule } from "../conversations/conversation.module";
import { ModelProviderModule } from "../model-providers/model-provider.module";
import { RunEventsModule } from "../run-events/run-events.module";

/**
 * Run 领域：一次执行的生命周期、事件记录/聚合。单向依赖 runtime / worker-host，
 * 并在启动时把 worker 事件统一入口注入 run executor；
 * WorkerUpstreamReceiver → worker-host 的 WorkerRunController。
 */
@Module({
  imports: [
    RuntimeModule,
    WorkerHostModule,
    RunEventsModule,
    ConversationModule,
    ModelProviderModule,
  ],
  controllers: [AdminRunController],
  providers: [
    RunRepository,
    LiveRunRegistry,
    WorkerEventsService,
    RunRecoveryService,
    RunConversationEffects,
    RunStatusService,
    RunService,
    LocalRunExecutor,
    SandboxRunExecutor,
    {
      provide: RUN_EXECUTORS,
      useFactory: (...executors: RunExecutor[]) => executors,
      inject: [LocalRunExecutor, SandboxRunExecutor],
    },
    RunExecutorRegistry,
    ExecutionService,
    WorkerAgUiEventHandler,
  ],
  exports: [RunService],
})
export class RunsModule implements OnModuleInit {
  constructor(
    private readonly runRecovery: RunRecoveryService,
    private readonly executionService: ExecutionService,
    private readonly runtimeProviderRegistry: RuntimeProviderRegistry,
    private readonly workerCommands: WorkerCommandDispatcher,
    private readonly commandQueue: WorkerCommandQueue,
    private readonly workerUpstream: WorkerUpstreamRegistry,
    private readonly liveRuns: LiveRunRegistry,
    private readonly workerEvents: WorkerEventsService
  ) {}

  async onModuleInit() {
    this.executionService.setRunEventReceiver(this.workerEvents);
    this.runtimeProviderRegistry
      .resolve("sandbox")
      .setOwnerSessionCleanup?.((ownerId) =>
        this.workerCommands.cleanupByOwnerId(ownerId)
      );
    this.commandQueue.setCommandSentRecorder(this.workerEvents);
    this.workerUpstream.setReceiver(this.workerEvents);
    this.liveRuns.setTimeoutErrorSink(this.workerEvents);
    await this.runRecovery.recoverInterruptedRuns();
  }
}
