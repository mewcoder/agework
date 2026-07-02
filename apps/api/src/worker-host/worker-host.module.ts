import { Module } from "@nestjs/common";

import { RuntimeModule } from "../runtime/runtime.module";
import { WorkerConfigStore } from "./config/config-store";
import { WorkerCommandQueue } from "./command/command-queue";
import { WorkerUpstreamRegistry } from "./upstream/worker-upstream.registry";
import { WorkerCommandDispatcher } from "./command/command-dispatcher.service";
import { WorkerCommandController } from "./command.controller";
import { WorkerRunController } from "./worker-run.controller";
import { WorkerEndpointHandler } from "./worker-endpoint.handler";
import { WorkerHostService } from "./worker-host.service";
import { WorkerRegistryRepository } from "./registry/worker-registry.repository";
import { SandboxInstanceExecutor } from "./sandbox/sandbox-instance.executor";
import { LocalInstanceExecutor } from "./local/local-instance.executor";
import { RuntimeInstanceLifecycleService } from "./lifecycle/lifecycle.service";
import { RuntimeInstanceLifecycleListener } from "./lifecycle/lifecycle.listener";
import { AdminRuntimeController } from "./admin/admin-runtime.controller";

/**
 * worker-host:API ↔ worker 进程之间的通信边界(配置下发、命令下发、上行事件),
 * WorkerRegistry 数据归属,以及 sandbox 实例编排(owner 复用/idle 决策)、runtime
 * 资源级联清理、admin 查询——这些原来分散在 `runtime` 模块里的编排逻辑,这次连同
 * WorkerRegistry 数据一起收拢到这里(设计文档 1.1 节)。物理 sandbox/local 操作
 * 经 `RuntimeService` 转发给 `runtime` 模块——这是 `worker-host → runtime` 唯一
 * 合法方向,`runtime` 从不反过来依赖 `worker-host`。
 *
 * 公开面只暴露 WorkerHostService。
 *
 * 开发阶段暂时移除了 worker 端点鉴权(原 WorkerAccessService/WorkerAuthGuard),
 * 待生命周期管理理清后再补。
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
    SandboxInstanceExecutor,
    LocalInstanceExecutor,
    RuntimeInstanceLifecycleService,
    RuntimeInstanceLifecycleListener,
    WorkerHostService,
  ],
  exports: [WorkerHostService],
})
export class WorkerHostModule {}
