import { Module } from "@nestjs/common";

// core
import { RunRepository } from "./run.repository";
import { LiveRunRegistry } from "./live-run/live-run.registry";
import { WorkerEventService } from "./upstream/worker-event.service";
import { WorkerSeqStore } from "./upstream/worker-seq.store";
import { RunStatusService } from "./status/run-status.service";
import { RunFinalizationStore } from "./status/run-finalization.store";
import { RunRecoveryService } from "./recovery/run-recovery.service";
import { RunWorkspaceListener } from "./workspace/run-workspace.listener";
import { WorkerLostListener } from "./upstream/worker-lost.listener";
import { RunService } from "./run.service";
import { RunLauncher } from "./launch/run-launcher";
import { RunDriver } from "./driver/run-driver";
import { WorkerAgUiEventHandler } from "./upstream/worker-agui-event.handler";

// controllers
import { AdminRunController } from "./admin/admin-run.controller";

// deps（向下依赖：worker-manager / run-event / conversation）
import { WorkerManagerModule } from "../worker-manager/worker-manager.module";
import { RunEventModule } from "../run-event/run-event.module";
import { ConversationModule } from "../conversation/conversation.module";

/**
 * Run 领域：一次执行的生命周期、事件记录/聚合。依赖 worker-manager 获取
 * runtime 环境，依赖 run-event 记录事件；直接 import ConversationModule，
 * Run 内部的 RunRecoveryService / RunStatusService / RunLauncher 直接注入
 * ConversationService 回写会话状态与消息。
 * CLI 路径由调用方（AgentService）参数喂入，不直接依赖 RuntimeModule。
 */
@Module({
  imports: [WorkerManagerModule, RunEventModule, ConversationModule],
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
    RunDriver,
    WorkerAgUiEventHandler,
    RunWorkspaceListener,
    WorkerLostListener,
  ],
  exports: [RunService],
})
export class RunModule {}
