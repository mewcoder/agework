import { Module } from "@nestjs/common";

import { WorkerConfigStore } from "./config/config-store";
import { WorkerCommandQueue } from "./command/command-queue";
import { WorkerAccessService } from "./access/access.service";
import { WorkerAuthGuard } from "./guards/auth.guard";
import { WorkerUpstreamRegistry } from "./upstream/worker-upstream.registry";
import { WorkerCommandDispatcher } from "./command/command-dispatcher.service";
import { WorkerCommandController } from "./command.controller";
import { WorkerRunController } from "./worker-run.controller";
import { WorkerEndpointHandler } from "./worker-endpoint.handler";
import { WorkerHostService } from "./worker-host.service";

/**
 * worker-host：API ↔ worker 进程之间的通信边界（配置下发、命令下发、上行事件、
 * 鉴权）。worker 调用的全部 HTTP 端点都在此。与 run / runtime 平级且不
 * 依赖任何一方——反向通知所需的端口（CommandSentRecorder / WorkerUpstreamReceiver）
 * 由各自在启动时注入实现。
 *
 * 公开面只暴露 WorkerHostService。命令下发、access key、上行事件注册表、
 * 配置存储、命令队列、鉴权 guard 都是 worker-host 内部实现。
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
    WorkerEndpointHandler,
    WorkerHostService,
  ],
  exports: [WorkerHostService],
})
export class WorkerHostModule {}
