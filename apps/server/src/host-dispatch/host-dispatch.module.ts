import { Module } from "@nestjs/common";

import { RuntimeHostModule } from "../runtime-host/runtime-host.module";
import { RunEventModule } from "../run-event/run-event.module";
import { WorkspaceModule } from "../workspace/workspace.module";
import { UserModule } from "../user/user.module";
import { RuntimeHostAdapter } from "./contract/runtime-host.adapter";
import { builtinRuntimeHostProvider } from "./contract/builtin-runtime-host";
import { OwnerHostListener } from "./contract/owner-host.listener";
import {
  RUNTIME_HOST_DIAGNOSTICS,
  RUNTIME_HOST_EXECUTION,
  RUNTIME_HOST_OPERATIONS,
} from "./host-dispatch.types";
import { AdminWorkerController } from "./admin/admin-worker.controller";

/**
 * Host 下发域组合根：装配 builtin Host、registered Host 路由适配器和
 * admin 观测面。worker 数据面由每个 Host 自己的 WorkerHttpServer 承接。
 *
 * 同一个 adapter 按 execution / operations / diagnostics 三个角色暴露；run
 * 模块只消费执行面契约，
 * 不感知 builtin/registered 的路由细节。
 *
 * 与 runtime-host 模块的边界：本模块管「下发」(submitRun 路由、builtin 装配、
 * worker 观测),runtime-host 管「节点资源」(注册行、隧道传输、Host 级判死),
 * 隧道管道经 RuntimeHostService 借用。
 */
@Module({
  imports: [RuntimeHostModule, RunEventModule, WorkspaceModule, UserModule],
  controllers: [AdminWorkerController],
  providers: [
    builtinRuntimeHostProvider,
    RuntimeHostAdapter,
    OwnerHostListener,
    { provide: RUNTIME_HOST_EXECUTION, useExisting: RuntimeHostAdapter },
    { provide: RUNTIME_HOST_OPERATIONS, useExisting: RuntimeHostAdapter },
    { provide: RUNTIME_HOST_DIAGNOSTICS, useExisting: RuntimeHostAdapter },
  ],
  exports: [
    RUNTIME_HOST_EXECUTION,
    RUNTIME_HOST_OPERATIONS,
    RUNTIME_HOST_DIAGNOSTICS,
  ],
})
export class HostDispatchModule {}
