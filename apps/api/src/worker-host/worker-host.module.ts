import { Module } from "@nestjs/common";

import { WorkerConfigStore } from "./config/config-store";
import { WorkerCommandQueue } from "./commands/command-queue";
import { WorkerAccessService } from "./access/access.service";
import { WorkerAuthGuard } from "./guards/auth.guard";
import { WorkerUpstreamRegistry } from "./upstream/worker-upstream.registry";
import { WorkerCommandDispatcher } from "./commands/command-dispatcher.service";
import { WorkerCommandController } from "./command.controller";
import { WorkerRunController } from "./worker-run.controller";

/**
 * worker-host：API ↔ worker 进程之间的通信边界（配置下发、命令下发、上行事件、
 * 鉴权）。worker 调用的全部 HTTP 端点都在此。与 run / runtime 平级且不
 * 依赖任何一方——反向通知所需的端口（CommandSentRecorder / WorkerUpstreamReceiver）
 * 由各自在启动时注入实现。
 *
 * 公开面只暴露跨模块真正用到的能力：命令下发（WorkerCommandDispatcher）、
 * access key（WorkerAccessService）、上行事件注册表（WorkerUpstreamRegistry）。
 * 配置存储、命令队列、鉴权 guard 是内部实现，不导出。
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
    WorkerCommandDispatcher,
    WorkerAccessService,
    WorkerUpstreamRegistry,
  ],
})
export class WorkerHostModule {}
