import { Module } from "@nestjs/common";

import { RuntimeConfigStore } from "./config-store";
import { RuntimeControlQueue } from "./control-queue";
import { WorkerAccessService } from "./access.service";
import { WorkerAuthGuard } from "./auth.guard";
import { RuntimeHeartbeatRegistry } from "./runtime-heartbeat.registry";
import { WorkerControlDispatcher } from "./worker-control-dispatcher.service";
import { WorkerRuntimeController } from "./worker-runtime.controller";
import { WorkerWorkspaceController } from "./worker-workspace.controller";

/**
 * worker-host：API ↔ worker 进程之间的通信基础设施（配置下发、控制下发、
 * 心跳上报、鉴权）。与 run / runtime 平级且不依赖任何一方——run 与 runtime 反向
 * 通知所需的端口（ControlSentRecorder / RuntimeInstanceHeartbeatSink）由各自在
 * 启动时注入实现。
 */
@Module({
  controllers: [WorkerRuntimeController, WorkerWorkspaceController],
  providers: [
    RuntimeConfigStore,
    RuntimeControlQueue,
    WorkerAccessService,
    WorkerAuthGuard,
    RuntimeHeartbeatRegistry,
    WorkerControlDispatcher,
  ],
  exports: [
    RuntimeConfigStore,
    RuntimeControlQueue,
    WorkerAccessService,
    WorkerAuthGuard,
    RuntimeHeartbeatRegistry,
    WorkerControlDispatcher,
  ],
})
export class WorkerHostModule {}
