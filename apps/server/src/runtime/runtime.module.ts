import { Module } from "@nestjs/common";

import { DockerSandboxEngine } from "./sandbox/docker-engine";
import { OpenSandboxEngine } from "./sandbox/opensandbox-engine";
import {
  OpenSandboxClient,
  OPENSANDBOX_CLIENT,
} from "./sandbox/opensandbox-client";
import { SANDBOX_ENGINES } from "./sandbox/sandbox-engine";
import type { SandboxEngine } from "./sandbox/sandbox-engine";
import { LocalRuntimeProvider } from "./local/local-runtime.provider";

import { RuntimeService } from "./runtime.service";

// external deps
import { ConfigService } from "../config/config.service";

/**
 * Runtime 领域:纯 Provider 引擎(docker/opensandbox engine + local fork 机制)
 * + placement 计算。不认识 WorkerRegistry、owner 复用规则、idle 决策,不碰 DB——
 * 是零依赖模块,唯一的调用方是 `worker-manager`。
 */
@Module({
  providers: [
    DockerSandboxEngine,
    {
      provide: OPENSANDBOX_CLIENT,
      useFactory: (configService: ConfigService) =>
        new OpenSandboxClient(configService),
      inject: [ConfigService],
    },
    OpenSandboxEngine,
    {
      provide: SANDBOX_ENGINES,
      useFactory: (...engines: SandboxEngine[]) => engines,
      inject: [DockerSandboxEngine, OpenSandboxEngine],
    },
    LocalRuntimeProvider,
    RuntimeService,
  ],
  exports: [
    // 公开面:根 Service 是 runtime 唯一稳定对外入口。
    RuntimeService,
  ],
})
export class RuntimeModule {}
