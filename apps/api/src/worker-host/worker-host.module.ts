import { Module } from "@nestjs/common";

import { WorkerConfigStore } from "./config-store";
import { WorkerCommandQueue } from "./command-queue";
import { WorkerAccessService } from "./access.service";
import { WorkerAuthGuard } from "./auth.guard";
import { WorkerUpstreamRegistry } from "./worker-upstream.registry";
import { WorkerCommandDispatcher } from "./command-dispatcher.service";
import { WorkerCommandController } from "./command.controller";
import { WorkerRunController } from "./worker-run.controller";

/**
 * worker-host：API ↔ worker 进程之间的通信边界（配置下发、命令下发、上行事件、
 * 鉴权）。worker 调用的全部 HTTP 端点都在此。与 run / runtime 平级且不
 * 依赖任何一方——反向通知所需的端口（CommandSentRecorder / WorkerUpstreamReceiver）
 * 由各自在启动时注入实现。
 */
@Module({
  controllers: [WorkerCommandController, WorkerRunController],
  providers: [
    WorkerConfigStore,
    WorkerCommandQueue,
    WorkerAccessService,
    WorkerAuthGuard,
    WorkerUpstreamRegistry,
    WorkerCommandDispatcher,
  ],
  exports: [
    WorkerConfigStore,
    WorkerCommandQueue,
    WorkerAccessService,
    WorkerAuthGuard,
    WorkerUpstreamRegistry,
    WorkerCommandDispatcher,
  ],
})
export class WorkerHostModule {}
