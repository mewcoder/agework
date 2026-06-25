import { Module, OnModuleInit } from "@nestjs/common";

// core
import { RunRepository } from "./run.repository";
import { RunActiveStore } from "./execution/run-active.store";
import { RunEnvelopeProcessor } from "./execution/run-envelope.processor";
import { RunExecutionStatusHandler } from "./execution/run-execution-status.handler";
import { RawEventLogWriter } from "./events/raw-event-log.writer";
import { RunEventRecorder, RunEventStore } from "./events/run-event-recorder";
import { RunEventQuery } from "./events/run-event-query";
import { RunRecoveryUseCase } from "./run-recovery.use-case";
import { RunService } from "./run.service";
import { RunConfigAssembler } from "./run-config.assembler";
import { RunEventReceiverImpl } from "./execution/run-event-receiver";
import { RunWorkerExecutionService } from "./execution/run-worker-execution.service";

// controllers
import { AdminRunController } from "./admin/admin-run.controller";
import { RunInternalController } from "./run-internal.controller";

// deps（向下依赖 runtime，以及 conversation / model-provider 领域）
import { RuntimeModule } from "../runtime/runtime.module";
import { RuntimeProviderRegistry } from "../runtime/providers/provider-registry";
import { RuntimeControlQueue } from "../runtime/internal/control-queue";
import { ConversationModule } from "../conversations/conversation.module";
import { ModelProviderModule } from "../model-providers/model-provider.module";

/**
 * Run 领域：一次执行的生命周期、事件记录/聚合、worker 事件入口。
 * 单向依赖 runtime（run 调用运行环境），并在启动时把 RunEventReceiver 实现注入
 * runtime 侧的 provider 与 control queue，以及恢复孤儿 run。
 */
@Module({
  imports: [RuntimeModule, ConversationModule, ModelProviderModule],
  controllers: [AdminRunController, RunInternalController],
  providers: [
    RunRepository,
    RunActiveStore,
    RunEnvelopeProcessor,
    RawEventLogWriter,
    RunEventStore,
    RunEventRecorder,
    RunEventQuery,
    RunRecoveryUseCase,
    RunExecutionStatusHandler,
    RunService,
    RunConfigAssembler,
    RunWorkerExecutionService,
    RunEventReceiverImpl,
  ],
  exports: [RunService, RunRepository, RunConfigAssembler],
})
export class RunsModule implements OnModuleInit {
  constructor(
    private readonly runRecovery: RunRecoveryUseCase,
    private readonly providerRegistry: RuntimeProviderRegistry,
    private readonly controlQueue: RuntimeControlQueue,
    private readonly runEventReceiver: RunEventReceiverImpl
  ) {}

  async onModuleInit() {
    // 把事件 receiver 注入 runtime 侧的 provider 与 control queue
    // （它们只认 RunEventReceiver 接口，不直接依赖 run 实现）
    this.providerRegistry.setRunEventReceiver(this.runEventReceiver);
    this.controlQueue.setRunEventReceiver(this.runEventReceiver);
    await this.runRecovery.recoverOrphanRuns();
  }
}
