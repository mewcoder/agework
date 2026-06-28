import { Module, OnModuleInit } from "@nestjs/common";

// core
import { RunRepository } from "./run.repository";
import { LiveRunRegistry } from "./live-run/live-run.registry";
import { WorkerEventService } from "./worker-event/worker-event.service";
import { RunStatusService } from "./status/run-status.service";
import { RunRecoveryService } from "./recovery/run-recovery.service";
import { RunService } from "./run.service";
import { RunLauncher } from "./launch/run-launcher";
import { RunConversationEffects } from "./conversation/run-conversation.effects";
import { ExecutionService } from "./execution/execution.service";
import {
  RUN_EXECUTORS,
  RunExecutorRegistry,
} from "./execution/executor.registry";
import type { RunExecutor } from "./execution/executor";
import { LocalRunExecutor } from "./execution/local.executor";
import { SandboxRunExecutor } from "./execution/sandbox.executor";
import { WorkerAgUiEventHandler } from "./worker-event/agui-event.handler";

// controllers
import { AdminRunController } from "./admin/admin-run.controller";

// deps（向下依赖 runtime / worker-host，以及 conversation / model-provider 领域）
import { RuntimeModule } from "../runtime/runtime.module";
import { RuntimeProviderRegistry } from "../runtime/providers/provider-registry";
import { WorkerHostModule } from "../worker-host/worker-host.module";
import { WorkerHostService } from "../worker-host/worker-host.service";
import { ConversationModule } from "../conversation/conversation.module";
import { ModelProviderModule } from "../model-provider/model-provider.module";
import { RunEventModule } from "../run-event/run-event.module";

/**
 * Run 领域：一次执行的生命周期、事件记录/聚合。单向依赖 runtime / worker-host，
 * 并在启动时把 worker 事件统一入口注入 run executor；
 * WorkerUpstreamReceiver → worker-host 的 WorkerRunController。
 */
@Module({
  imports: [
    RuntimeModule,
    WorkerHostModule,
    RunEventModule,
    ConversationModule,
    ModelProviderModule,
  ],
  controllers: [AdminRunController],
  providers: [
    RunRepository,
    LiveRunRegistry,
    WorkerEventService,
    RunRecoveryService,
    RunConversationEffects,
    RunStatusService,
    RunService,
    RunLauncher,
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
export class RunModule implements OnModuleInit {
  constructor(
    private readonly runRecovery: RunRecoveryService,
    private readonly executionService: ExecutionService,
    private readonly runtimeProviderRegistry: RuntimeProviderRegistry,
    private readonly workerHost: WorkerHostService,
    private readonly liveRuns: LiveRunRegistry,
    private readonly workerEvents: WorkerEventService
  ) {}

  async onModuleInit() {
    this.executionService.setRunEventReceiver(this.workerEvents);
    this.runtimeProviderRegistry
      .resolve("sandbox")
      .setOwnerSessionCleanup?.((ownerId) =>
        this.workerHost.cleanupByOwnerId(ownerId)
      );
    this.workerHost.setCommandSentRecorder(this.workerEvents);
    this.workerHost.setReceiver(this.workerEvents);
    this.liveRuns.setTimeoutErrorSink(this.workerEvents);
    await this.runRecovery.recoverInterruptedRuns();
  }
}
