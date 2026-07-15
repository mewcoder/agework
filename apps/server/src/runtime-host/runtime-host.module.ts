import { Module } from "@nestjs/common";

import { RuntimeHostService } from "./runtime-host.service";
import { RuntimeHostController } from "./runtime-host.controller";
import { AdminRuntimeHostController } from "./admin/admin-runtime-host.controller";
import { AdminWorkerController } from "./admin/admin-worker.controller";
import { RuntimeHostRepository } from "./runtime-host.repository";
import { HostTunnelHandler } from "./gateway/host-tunnel.handler";
import { HostLivenessWatchdog } from "./gateway/host-liveness.watchdog";
import { RuntimeHostAdapter } from "./contract/runtime-host.adapter";
import { builtinRuntimeHostProvider } from "./contract/builtin-runtime-host";
import { RunEventModule } from "../run-event/run-event.module";
import {
  RUNTIME_HOST_DIAGNOSTICS,
  RUNTIME_HOST_CONNECTIVITY,
  RUNTIME_HOST_ENVIRONMENT,
  RUNTIME_HOST_EXECUTION,
  RUNTIME_HOST_OWNER_RECONCILIATION,
  RUNTIME_HOST_RUN_REAP_BINDING,
  RUNTIME_HOST_UPSTREAM_BINDING,
  RUNTIME_HOST_WORKSPACE_DATA,
} from "./runtime-host.types";

/**
 * Runtime Host 域组合根:节点资源(注册行、配对、隧道、判死)+ 下发面
 * (contract 路由、builtin 装配、admin worker 观测)。
 *
 * - `HostTunnelHandler`(隧道 WS 端点)、`HostLivenessWatchdog`(Host 级判死)、
 *   builtin Host 实例都是 internal provider,不 export。
 * - `RuntimeHostAdapter` 类本身不直接 export,而是按 execution / upstream-binding /
 *   connectivity / environment / workspace-data / diagnostics 角色 token 暴露契约;
 *   消费者不感知 builtin/registered 的路由细节。
 * - worker 数据面由每个 Host 自己的 WorkerHttpServer 承接;worker 池由 Host
 *   进程内自治,本模块只经契约下发与观测。
 * - owner 生命周期清理不在本模块:workspace / user 模块各自监听事件后
 *   向下调 owner reconciliation token；业务模块不消费 Worker diagnostics。
 */
@Module({
  imports: [RunEventModule],
  providers: [
    RuntimeHostService,
    RuntimeHostRepository,
    HostTunnelHandler,
    HostLivenessWatchdog,
    builtinRuntimeHostProvider,
    RuntimeHostAdapter,
    { provide: RUNTIME_HOST_EXECUTION, useExisting: RuntimeHostAdapter },
    { provide: RUNTIME_HOST_UPSTREAM_BINDING, useExisting: RuntimeHostAdapter },
    { provide: RUNTIME_HOST_CONNECTIVITY, useExisting: RuntimeHostAdapter },
    { provide: RUNTIME_HOST_ENVIRONMENT, useExisting: RuntimeHostAdapter },
    { provide: RUNTIME_HOST_WORKSPACE_DATA, useExisting: RuntimeHostAdapter },
    { provide: RUNTIME_HOST_DIAGNOSTICS, useExisting: RuntimeHostAdapter },
    {
      provide: RUNTIME_HOST_OWNER_RECONCILIATION,
      useExisting: RuntimeHostAdapter,
    },
    {
      provide: RUNTIME_HOST_RUN_REAP_BINDING,
      useExisting: RuntimeHostAdapter,
    },
  ],
  controllers: [
    RuntimeHostController,
    AdminRuntimeHostController,
    AdminWorkerController,
  ],
  exports: [
    RuntimeHostService,
    RUNTIME_HOST_EXECUTION,
    RUNTIME_HOST_UPSTREAM_BINDING,
    RUNTIME_HOST_ENVIRONMENT,
    RUNTIME_HOST_WORKSPACE_DATA,
    RUNTIME_HOST_DIAGNOSTICS,
    RUNTIME_HOST_OWNER_RECONCILIATION,
    RUNTIME_HOST_RUN_REAP_BINDING,
  ],
})
export class RuntimeHostModule {}
