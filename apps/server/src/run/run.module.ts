import { Module } from "@nestjs/common";

// core
import { RunRepository } from "./run.repository";
import { LiveRunRegistry } from "./live-run/live-run.registry";
import { WorkerEventHandler } from "./upstream/worker-event.handler";
import { WorkerSeqStore } from "./upstream/worker-seq.store";
import { RunStatusService } from "./status/run-status.service";
import { RunFinalizationStore } from "./status/run-finalization.store";
import { RunRecoveryService } from "./recovery/run-recovery.service";
import { RunWorkspaceListener } from "./workspace/run-workspace.listener";
import { RunService } from "./run.service";
import { RunLauncher } from "./launch/run.launcher";
import { WorkerAgUiEventHandler } from "./upstream/worker-agui-event.handler";

// controllers
import { AdminRunController } from "./admin/admin-run.controller";

// deps（向下依赖：runtime-host / run-event / conversation / runtime）
import { RuntimeHostModule } from "../runtime-host/runtime-host.module";
import { RunEventModule } from "../run-event/run-event.module";
import { ConversationModule } from "../conversation/conversation.module";
import { RuntimeModule } from "../runtime/runtime.module";

/**
 * Run 领域：一次执行的生命周期、事件记录/聚合。执行面只经 RUNTIME_HOST_CONTRACT
 * 契约消费（runtime-host 模块导出的 token），run 内部
 * 看不见 worker/RunConfig/CLI 路径等执行机细节；依赖 run-event 记录事件；
 * 直接 import ConversationModule，Run 内部的 RunRecoveryService /
 * RunStatusService / RunLauncher 直接注入 ConversationService 回写会话状态与消息。
 */
@Module({
  imports: [
    RuntimeHostModule,
    RunEventModule,
    ConversationModule,
    RuntimeModule,
  ],
  controllers: [AdminRunController],
  providers: [
    RunRepository,
    LiveRunRegistry,
    WorkerEventHandler,
    WorkerSeqStore,
    RunRecoveryService,
    RunStatusService,
    RunFinalizationStore,
    RunService,
    RunLauncher,
    WorkerAgUiEventHandler,
    RunWorkspaceListener,
  ],
  exports: [RunService],
})
export class RunModule {}
