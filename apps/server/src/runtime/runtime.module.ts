import { Module } from "@nestjs/common";

import { RuntimeService } from "./runtime.service";
import { RuntimeController } from "./runtime.controller";
import { AdminRuntimeController } from "./admin/admin-runtime.controller";
import { RuntimeRepository } from "./runtime.repository";
import { LocalRuntime } from "./local/local-runtime";
import { RuntimeTunnelHandler } from "./gateway/runtime-tunnel.handler";
import { RuntimeLivenessWatchdog } from "./gateway/runtime-liveness.watchdog";

/**
 * Runtime 领域的组合根:门面 Service + Managed 实现 + Registered 配对/隧道。
 * `LocalRuntime`(Managed in-process 实现)、`RuntimeTunnelHandler`(隧道 WS 端点)、
 * `RuntimeLivenessWatchdog`(Runtime 级判死)都是 internal provider,不 export;
 * 上层经 `RuntimeService.runtimeFor()` 拿 `Runtime` 接口。
 */
@Module({
  providers: [
    RuntimeService,
    RuntimeRepository,
    LocalRuntime,
    RuntimeTunnelHandler,
    RuntimeLivenessWatchdog,
  ],
  controllers: [RuntimeController, AdminRuntimeController],
  exports: [RuntimeService],
})
export class RuntimeModule {}
