import { Module, OnModuleInit } from "@nestjs/common";

// core
import { RunRepository } from "./run.repository";
import { ActiveRunRegistry } from "./lifecycle/active-run.registry";
import { WorkerEventProcessor } from "./worker/worker-event.processor";
import { RunStatusService } from "./lifecycle/run-status.service";
import { AgentEventTraceWriter } from "./events/agent-event-trace.writer";
import { RunEventRepository } from "./events/run-event.repository";
import { RunEventService } from "./events/run-event.service";
import { RunEventQuery } from "./admin/run-event.query";
import { RunRecoveryService } from "./lifecycle/run-recovery.service";
import { RunService } from "./run.service";
import { WorkerEventReceiverAdapter } from "./worker/worker-event-receiver.adapter";
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
 * 并在启动时把 worker 事件统一入口注入下层：RunEventReceiver → runtime provider /
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
    ActiveRunRegistry,
    WorkerEventProcessor,
    AgentEventTraceWriter,
    RunEventRepository,
    RunEventService,
    RunEventQuery,
    RunRecoveryService,
    RunStatusService,
    RunService,
    RunDriver,
    WorkerEventReceiverAdapter,
  ],
  exports: [RunService, RunRepository],
})
export class RunsModule implements OnModuleInit {
  constructor(
    private readonly runRecovery: RunRecoveryService,
    private readonly providerRegistry: RuntimeProviderRegistry,
    private readonly commandQueue: WorkerCommandQueue,
    private readonly commandDispatcher: WorkerCommandDispatcher,
    private readonly accessService: WorkerAccessService,
    private readonly workerUpstream: WorkerUpstreamRegistry,
    private readonly activeRuns: ActiveRunRegistry,
    private readonly workerEventProcessor: WorkerEventProcessor,
    private readonly workerEvents: WorkerEventReceiverAdapter
  ) {}

  async onModuleInit() {
    // 把反向通知端口的实现注入下层（它们只认接口，不直接依赖 run 实现）：
    this.providerRegistry.setRunEventReceiver(this.workerEvents);
    this.providerRegistry.setCommandPort(this.commandDispatcher);
    this.providerRegistry.setAccessPort(this.accessService);
    this.commandQueue.setCommandSentRecorder(this.workerEvents);
    this.workerUpstream.setReceiver(this.workerEvents);
    this.activeRuns.setTimeoutErrorSink(this.workerEventProcessor);
    await this.runRecovery.recoverOrphanRuns();
  }
}
