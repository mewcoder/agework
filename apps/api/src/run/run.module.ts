import { Module } from "@nestjs/common";

// core
import { RunRepository } from "./run.repository";
import { LiveRunRegistry } from "./live-run/live-run.registry";
import { WorkerEventService } from "./worker-event/worker-event.service";
import { WorkerSeqStore } from "./worker-event/worker-seq.store";
import { RunStatusService } from "./status/run-status.service";
import { RunFinalizationStore } from "./status/run-finalization.store";
import { RunRecoveryService } from "./recovery/run-recovery.service";
import { RunStartupService } from "./startup/run-startup.service";
import { RunWorkspaceListener } from "./workspace/run-workspace.listener";
import { RunService } from "./run.service";
import { RunLauncher } from "./launch/run-launcher";
import { ExecutionService } from "./execution/execution.service";
import { WorkerRunExecutor } from "./execution/worker-run.executor";
import { WorkerAgUiEventHandler } from "./worker-event/agui-event.handler";

// controllers
import { AdminRunController } from "./admin/admin-run.controller";

// deps（向下依赖：worker-host / run-event / conversation）
import { WorkerHostModule } from "../worker-host/worker-host.module";
import { RunEventModule } from "../run-event/run-event.module";
import { ConversationModule } from "../conversation/conversation.module";

/**
 * Run 领域：一次执行的生命周期、事件记录/聚合。只依赖 worker-host 一个模块获取
 * runtime 环境（placement 解析、实例取得/释放/回收 全部经 WorkerHostService,
 * runtimeType 判断收在 worker-host 内部,见设计文档第一节),另外向下依赖
 * run-event / conversation（直接写回会话状态），并在启动时把 worker 事件统一入口
 * 注入 run executor；WorkerUpstreamPort → worker-host 的 WorkerRunController。
 */
@Module({
  imports: [WorkerHostModule, RunEventModule, ConversationModule],
  controllers: [AdminRunController],
  providers: [
    RunRepository,
    LiveRunRegistry,
    WorkerEventService,
    WorkerSeqStore,
    RunRecoveryService,
    RunStatusService,
    RunFinalizationStore,
    RunService,
    RunLauncher,
    WorkerRunExecutor,
    ExecutionService,
    WorkerAgUiEventHandler,
    RunStartupService,
    RunWorkspaceListener,
  ],
  exports: [RunService],
})
export class RunModule {}
