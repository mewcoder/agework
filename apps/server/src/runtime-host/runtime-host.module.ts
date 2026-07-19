import { Module } from "@nestjs/common";

import { RuntimeHostService } from "./runtime-host.service";
import { RuntimeHostController } from "./runtime-host.controller";
import { AdminRuntimeHostController } from "./admin/admin-runtime-host.controller";
import { AdminWorkerController } from "./admin/admin-worker.controller";
import { RuntimeHostRepository } from "./runtime-host.repository";
import { HostTunnelHandler } from "./gateway/host-tunnel.handler";
import { HostLivenessWatchdog } from "./gateway/host-liveness.watchdog";
import { RuntimeHostAdapter } from "./contract/runtime-host.adapter";
import { TunnelRuntimeHost } from "./contract/tunnel-runtime-host";
import {
  builtinRuntimeHostLifecycleProvider,
  builtinRuntimeHostProvider,
} from "./contract/builtin-runtime-host";
import { RunEventModule } from "../run-event/run-event.module";
import {
  RUNTIME_HOST_EXECUTION,
  RUNTIME_HOST_RUN_REAP_BINDING,
  RUNTIME_HOST_UPSTREAM_BINDING,
} from "./runtime-host.types";

/**
 * Runtime Host 域组合根:节点资源(注册行、配对、隧道、判死)+ 下发面
 * (contract 路由、builtin 装配、admin worker 观测)。
 *
 * - `HostTunnelHandler`(隧道 WS 端点)、`HostLivenessWatchdog`(Host 级判死)、
 *   builtin Host 实例都是 internal provider,不 export。
 * - `RuntimeHostAdapter` 类本身不 export；业务用例经根 `RuntimeHostService`，run
 *   执行与两个启动期反向接线保留窄 token。
 * - worker 数据面由每个 Host 自己的 WorkerHttpServer 承接;worker 池由 Host
 *   进程内自治,本模块只经契约下发与观测。
 * - 资源生命周期判断归 workspace / user owner；重连同步用例由上层 run
 *   coordinator 编排各根 Service。diagnostics 供上层根 Service 编排 admin
 *   观测用例(如 run 模块的 admin 详情)。
 */
@Module({
  imports: [RunEventModule],
  providers: [
    RuntimeHostService,
    RuntimeHostRepository,
    HostTunnelHandler,
    HostLivenessWatchdog,
    builtinRuntimeHostLifecycleProvider,
    builtinRuntimeHostProvider,
    TunnelRuntimeHost,
    RuntimeHostAdapter,
    { provide: RUNTIME_HOST_EXECUTION, useExisting: RuntimeHostAdapter },
    { provide: RUNTIME_HOST_UPSTREAM_BINDING, useExisting: RuntimeHostAdapter },
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
    RUNTIME_HOST_RUN_REAP_BINDING,
  ],
})
export class RuntimeHostModule {}
