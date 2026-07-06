import { Module } from "@nestjs/common";

// core
import { RunRepository } from "./run.repository";
import { LiveRunRegistry } from "./live-run/live-run.registry";
import { WorkerEventService } from "./upstream/worker-event.service";
import { WorkerSeqStore } from "./upstream/worker-seq.store";
import { RunStatusService } from "./status/run-status.service";
import { RunFinalizationStore } from "./status/run-finalization.store";
import { RunRecoveryService } from "./recovery/run-recovery.service";
import { RunStartupService } from "./startup/run-startup.service";
import { RunWorkspaceListener } from "./workspace/run-workspace.listener";
import { RunService } from "./run.service";
import { RunLauncher } from "./launch/run-launcher";
import { RunDriver } from "./driver/run-driver";
import { WorkerAgUiEventHandler } from "./upstream/worker-agui-event.handler";

// controllers
import { AdminRunController } from "./admin/admin-run.controller";

// deps（向下依赖：worker-manager / run-event / conversation / runtime）
import { WorkerManagerModule } from "../worker-manager/worker-manager.module";
import { RunEventModule } from "../run-event/run-event.module";
import { ConversationModule } from "../conversation/conversation.module";
import { RuntimeModule } from "../runtime/runtime.module";

/**
 * Run 领域：一次执行的生命周期、事件记录/聚合。只依赖 worker-manager 一个模块获取
 * runtime 环境（placement 解析、实例取得/释放/回收 全部经 WorkerManagerService,
 * runtimeType 判断收在 worker-manager 内部,见设计文档第一节),另外向下依赖
 * run-event / conversation（直接写回会话状态），并在启动时把 worker 事件统一入口
 * 注入 run driver；WorkerUpstreamPort → worker-manager 的 WorkerRunController。
 */
@Module({
  imports: [WorkerManagerModule, RunEventModule, ConversationModule, RuntimeModule],
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
    RunStartupService,
    RunWorkspaceListener,
  ],
  exports: [RunService],
})
export class RunModule {}
