import { Module } from "@nestjs/common";

// core
import { RunRepository } from "./run.repository";
import { LiveRunRegistry } from "./live-run/live-run.registry";
import { WorkerEventService } from "./worker-event/worker-event.service";
import { RunStatusService } from "./status/run-status.service";
import { RunRecoveryService } from "./recovery/run-recovery.service";
import { RunStartupService } from "./startup/run-startup.service";
import { RunWorkspaceListener } from "./workspace/run-workspace.listener";
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

// deps（向下依赖：runtime / worker-host / run-event / conversation）
import { RuntimeModule } from "../runtime/runtime.module";
import { WorkerHostModule } from "../worker-host/worker-host.module";
import { RunEventModule } from "../run-event/run-event.module";
import { ConversationModule } from "../conversation/conversation.module";

/**
 * Run 领域：一次执行的生命周期、事件记录/聚合。向下依赖 runtime / worker-host /
 * run-event / conversation（执行中经 RunConversationEffects 写回会话状态），并在
 * 启动时把 worker 事件统一入口注入 run executor；
 * WorkerUpstreamPort → worker-host 的 WorkerRunController。
 */
@Module({
  imports: [RuntimeModule, WorkerHostModule, RunEventModule, ConversationModule],
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
    RunStartupService,
    RunWorkspaceListener,
  ],
  exports: [RunService],
})
export class RunModule {}
