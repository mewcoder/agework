import { Module } from "@nestjs/common";

// core
import { RunRepository } from "./run.repository";
import { LiveRunRegistry } from "./live-run/live-run.registry";
import { HostUpstreamHandler } from "./upstream/host-upstream.handler";
import { UpstreamSeqStore } from "./upstream/upstream-seq.store";
import { RunStatusService } from "./status/run-status.service";
import { RunFinalizationStore } from "./status/run-finalization.store";
import { RunRecoveryService } from "./recovery/run-recovery.service";
import { RunWorkspaceListener } from "./workspace/run-workspace.listener";
import { RunUserListener } from "./user/run-user.listener";
import { RunService } from "./run.service";
import { RunLauncher } from "./launch/run.launcher";
import { HostAgUiEventHandler } from "./upstream/host-agui-event.handler";
import { RuntimeHostReconciliationCoordinator } from "./recovery/runtime-host-reconciliation.coordinator";

// controllers
import { AdminRunController } from "./admin/admin-run.controller";

// deps（向下依赖：runtime-host / run-event / conversation）
import { RunEventModule } from "../run-event/run-event.module";
import { ConversationModule } from "../conversation/conversation.module";
import { RuntimeHostModule } from "../runtime-host/runtime-host.module";
import { WorkspaceModule } from "../workspace/workspace.module";
import { UserModule } from "../user/user.module";

/**
 * Run 领域：一次执行的生命周期、事件记录/聚合。普通用例只经
 * RUNTIME_HOST_EXECUTION 角色消费，HostUpstreamHandler 另用启动期 binding 接线上行；run 内部
 * 看不见 worker/RunConfig/CLI 路径等执行机细节；依赖 run-event 记录事件；
 * 直接 import ConversationModule，Run 内部的 RunRecoveryService /
 * RunStatusService / RunLauncher 直接注入 ConversationService 回写会话状态与消息。
 */
@Module({
  imports: [
    RuntimeHostModule,
    RunEventModule,
    ConversationModule,
    WorkspaceModule,
    UserModule,
  ],
  controllers: [AdminRunController],
  providers: [
    RunRepository,
    LiveRunRegistry,
    HostUpstreamHandler,
    UpstreamSeqStore,
    RunRecoveryService,
    RuntimeHostReconciliationCoordinator,
    RunStatusService,
    RunFinalizationStore,
    RunService,
    RunLauncher,
    HostAgUiEventHandler,
    RunWorkspaceListener,
    RunUserListener,
  ],
  exports: [RunService],
})
export class RunModule {}
