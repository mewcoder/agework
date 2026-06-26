import { Module } from "@nestjs/common";

import { RuntimeConfigStore } from "./config-store";
import { RuntimeCommandQueue } from "./command-queue";
import { WorkerAccessService } from "./access.service";
import { WorkerAuthGuard } from "./auth.guard";
import { RuntimeHeartbeatRegistry } from "./runtime-heartbeat.registry";
import { WorkerCommandDispatcher } from "./worker-command-dispatcher.service";
import { WorkerCommandController } from "./worker-command.controller";

/**
 * worker-host：API ↔ worker 进程之间的通信基础设施（配置下发、命令下发、
 * 心跳上报、鉴权）。与 run / runtime 平级且不依赖任何一方——run 与 runtime 反向
 * 通知所需的端口（CommandSentRecorder / RuntimeInstanceHeartbeatSink）由各自在
 * 启动时注入实现。
 */
@Module({
  controllers: [WorkerCommandController],
  providers: [
    RuntimeConfigStore,
    RuntimeCommandQueue,
    WorkerAccessService,
    WorkerAuthGuard,
    RuntimeHeartbeatRegistry,
    WorkerCommandDispatcher,
  ],
  exports: [
    RuntimeConfigStore,
    RuntimeCommandQueue,
    WorkerAccessService,
    WorkerAuthGuard,
    RuntimeHeartbeatRegistry,
    WorkerCommandDispatcher,
  ],
})
export class WorkerHostModule {}
