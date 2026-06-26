import { Module, OnModuleInit } from "@nestjs/common";

// core
import { RunRepository } from "./run.repository";
import { RunActiveStore } from "./lifecycle/run-active.store";
import { RunEnvelopeProcessor } from "./lifecycle/run-envelope.processor";
import { RunStatusHandler } from "./lifecycle/run-status.handler";
import { RawEventLogWriter } from "./events/raw-event-log.writer";
import { RunEventRecorder, RunEventStore } from "./events/run-event-recorder";
import { RunEventQuery } from "./events/run-event-query";
import { RunRecoveryUseCase } from "./lifecycle/run-recovery.use-case";
import { RunService } from "./run.service";
import { RunEventReceiverAdapter } from "./worker/run-event-receiver.adapter";
import { WorkerUpstreamAdapter } from "./worker/worker-upstream.adapter";
import { RunDriver } from "./worker/run-driver";

// controllers
import { AdminRunController } from "./admin/admin-run.controller";

// deps（向下依赖 runtime / worker-host，以及 conversation / model-provider 领域）
import { RuntimeModule } from "../runtime/runtime.module";
import { RuntimeProviderRegistry } from "../runtime/providers/provider-registry";
import { WorkerHostModule } from "../worker-host/worker-host.module";
import { WorkerCommandQueue } from "../worker-host/command-queue";
import { WorkerCommandDispatcher } from "../worker-host/command-dispatcher.service";
import { WorkerAccessService } from "../worker-host/access.service";
import { WorkerUpstreamRegistry } from "../worker-host/worker-upstream.registry";
import { ConversationModule } from "../conversations/conversation.module";
import { ModelProviderModule } from "../model-providers/model-provider.module";

/**
 * Run 领域：一次执行的生命周期、事件记录/聚合。单向依赖 runtime / worker-host，
 * 并在启动时把反向通知端口的实现注入下层：RunEventReceiver → runtime provider /
 * command queue；WorkerUpstreamReceiver → worker-host 的 WorkerRunController。
 */
@Module({
  imports: [
    RuntimeModule,
    WorkerHostModule,
    ConversationModule,
    ModelProviderModule,
  ],
  controllers: [AdminRunController],
  providers: [
    RunRepository,
    RunActiveStore,
    RunEnvelopeProcessor,
    RawEventLogWriter,
    RunEventStore,
    RunEventRecorder,
    RunEventQuery,
    RunRecoveryUseCase,
    RunStatusHandler,
    RunService,
    RunDriver,
    RunEventReceiverAdapter,
    WorkerUpstreamAdapter,
  ],
  exports: [RunService, RunRepository],
})
export class RunsModule implements OnModuleInit {
  constructor(
    private readonly runRecovery: RunRecoveryUseCase,
    private readonly providerRegistry: RuntimeProviderRegistry,
    private readonly commandQueue: WorkerCommandQueue,
    private readonly commandDispatcher: WorkerCommandDispatcher,
    private readonly accessService: WorkerAccessService,
    private readonly workerUpstream: WorkerUpstreamRegistry,
    private readonly runRegistry: RunActiveStore,
    private readonly runEventProcessor: RunEnvelopeProcessor,
    private readonly runEventReceiver: RunEventReceiverAdapter,
    private readonly workerUpstreamAdapter: WorkerUpstreamAdapter
  ) {}

  async onModuleInit() {
    // 把反向通知端口的实现注入下层（它们只认接口，不直接依赖 run 实现）：
    this.providerRegistry.setRunEventReceiver(this.runEventReceiver);
    this.providerRegistry.setCommandPort(this.commandDispatcher);
    this.providerRegistry.setAccessPort(this.accessService);
    this.commandQueue.setCommandSentRecorder(this.runEventReceiver);
    this.workerUpstream.setReceiver(this.workerUpstreamAdapter);
    this.runRegistry.setTimeoutErrorSink(this.runEventProcessor);
    await this.runRecovery.recoverOrphanRuns();
  }
}
