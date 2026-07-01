import { Module } from "@nestjs/common";

import { WorkerConfigStore } from "./config/config-store";
import { WorkerCommandQueue } from "./command/command-queue";
import { WorkerUpstreamRegistry } from "./upstream/worker-upstream.registry";
import { WorkerCommandDispatcher } from "./command/command-dispatcher.service";
import { WorkerCommandController } from "./command.controller";
import { WorkerRunController } from "./worker-run.controller";
import { WorkerEndpointHandler } from "./worker-endpoint.handler";
import { WorkerHostService } from "./worker-host.service";

/**
 * worker-host：API ↔ worker 进程之间的通信边界（配置下发、命令下发、上行事件）。
 * worker 调用的全部 HTTP 端点都在此。被 run / runtime 依赖,自身不反依赖
 * 任何一方——反向通知所需的端口（WorkerUpstreamPort）由实现方 run 在启动时注入。
 *
 * 公开面只暴露 WorkerHostService。命令下发、上行事件注册表、
 * 配置存储、命令队列都是 worker-host 内部实现。
 *
 * 开发阶段暂时移除了 worker 端点鉴权（原 WorkerAccessService/WorkerAuthGuard），
 * 待生命周期管理理清后再补。
 */
@Module({
  controllers: [WorkerCommandController, WorkerRunController],
  providers: [
    WorkerConfigStore,
    WorkerCommandQueue,
    WorkerUpstreamRegistry,
    WorkerCommandDispatcher,
    WorkerEndpointHandler,
    WorkerHostService,
  ],
  exports: [WorkerHostService],
})
export class WorkerHostModule {}
