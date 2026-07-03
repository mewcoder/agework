import { Module } from "@nestjs/common";

import { RuntimeModule } from "../runtime/runtime.module";
import { WorkerConfigStore } from "./config/config-store";
import { WorkerCommandQueue } from "./command/command-queue";
import { WorkerUpstreamRegistry } from "./upstream/worker-upstream.registry";
import { WorkerCommandDispatcher } from "./command/command-dispatcher.service";
import { WorkerCommandController } from "./command.controller";
import { WorkerRunController } from "./worker-run.controller";
import { WorkerEndpointHandler } from "./endpoint/worker-endpoint.handler";
import { WorkerManagerService } from "./worker-manager.service";
import { WorkerRegistryRepository } from "./registry/worker-registry.repository";
import { WorkerProvisioner } from "./instance/worker.provisioner";
import { RuntimeInstanceLifecycleService } from "./lifecycle/lifecycle.service";
import { RuntimeInstanceLifecycleListener } from "./lifecycle/lifecycle.listener";
import { AdminRuntimeController } from "./admin/admin-runtime.controller";
import { WorkerHandshakeStore } from "./handshake/worker-handshake.store";
import { WorkerTokenGuard } from "./handshake/worker-token.guard";
import { WorkerLivenessStore } from "./liveness/worker-liveness.store";
import { WorkerLivenessWatchdog } from "./liveness/worker-liveness.watchdog";

/**
 * worker-manager:API ↔ worker 进程之间的通信边界(配置下发、命令下发、上行事件),
 * WorkerRegistry 数据归属,以及 sandbox 实例编排(owner 复用/idle 决策)、runtime
 * 资源级联清理、admin 查询——这些原来分散在 `runtime` 模块里的编排逻辑,这次连同
 * WorkerRegistry 数据一起收拢到这里(设计文档 1.1 节)。物理 sandbox/local 操作
 * 经 `RuntimeService` 转发给 `runtime` 模块——这是 `worker-manager → runtime` 唯一
 * 合法方向,`runtime` 从不反过来依赖 `worker-manager`。
 *
 * 公开面只暴露 WorkerManagerService。
 *
 * commands/runConfig/events 三个端点靠 WorkerTokenGuard 校验 startToken;
 * register 端点不接这个 guard,走 WorkerHandshakeStore 那套 token-in-body 机制。
 */
@Module({
  imports: [RuntimeModule],
  controllers: [
    WorkerCommandController,
    WorkerRunController,
    AdminRuntimeController,
  ],
  providers: [
    WorkerConfigStore,
    WorkerCommandQueue,
    WorkerUpstreamRegistry,
    WorkerCommandDispatcher,
    WorkerEndpointHandler,
    WorkerRegistryRepository,
    WorkerHandshakeStore,
    WorkerTokenGuard,
    WorkerProvisioner,
    RuntimeInstanceLifecycleService,
    RuntimeInstanceLifecycleListener,
    WorkerLivenessStore,
    WorkerLivenessWatchdog,
    WorkerManagerService,
  ],
  exports: [WorkerManagerService],
})
export class WorkerManagerModule {}
