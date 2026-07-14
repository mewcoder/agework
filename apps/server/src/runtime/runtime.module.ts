import { Module } from "@nestjs/common";

import { RuntimeService } from "./runtime.service";
import { RuntimeController } from "./runtime.controller";
import { AdminRuntimeController } from "./admin/admin-runtime.controller";
import { RuntimeRepository } from "./runtime.repository";
import { RuntimeTunnelHandler } from "./gateway/runtime-tunnel.handler";
import { RuntimeLivenessWatchdog } from "./gateway/runtime-liveness.watchdog";

/**
 * Runtime Host 资源域组合根：门面 Service + builtin 状态 + registered 配对/隧道。
 * `RuntimeTunnelHandler`(隧道 WS 端点)、`RuntimeLivenessWatchdog`(Host 级判死)
 * 都是 internal provider,不 export。
 *
 * 与 runtime-host 模块的边界：本模块管「机器资源」(注册行、隧道传输、Host 级判死),
 * runtime-host 管「契约语义」(submitRun 路由、builtin 装配、worker 观测)。
 */
@Module({
  providers: [
    RuntimeService,
    RuntimeRepository,
    RuntimeTunnelHandler,
    RuntimeLivenessWatchdog,
  ],
  controllers: [RuntimeController, AdminRuntimeController],
  exports: [RuntimeService],
})
export class RuntimeModule {}
