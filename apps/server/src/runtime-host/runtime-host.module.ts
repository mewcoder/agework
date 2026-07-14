import { Module } from "@nestjs/common";

import { RuntimeHostService } from "./runtime-host.service";
import { RuntimeHostController } from "./runtime-host.controller";
import { AdminRuntimeHostController } from "./admin/admin-runtime-host.controller";
import { RuntimeHostRepository } from "./runtime-host.repository";
import { HostTunnelHandler } from "./gateway/host-tunnel.handler";
import { HostLivenessWatchdog } from "./gateway/host-liveness.watchdog";

/**
 * Runtime Host 资源域组合根：门面 Service + builtin 状态 + registered 配对/隧道。
 * `HostTunnelHandler`(隧道 WS 端点)、`HostLivenessWatchdog`(Host 级判死)
 * 都是 internal provider,不 export。
 *
 * 与 host-dispatch 模块的边界：本模块管「节点资源」(注册行、隧道传输、Host 级判死),
 * host-dispatch 管「下发」(submitRun 路由、builtin 装配、worker 观测)。
 */
@Module({
  providers: [
    RuntimeHostService,
    RuntimeHostRepository,
    HostTunnelHandler,
    HostLivenessWatchdog,
  ],
  controllers: [RuntimeHostController, AdminRuntimeHostController],
  exports: [RuntimeHostService],
})
export class RuntimeHostModule {}
