import { Module } from "@nestjs/common";

import {
  OpenSandboxClient,
  OPENSANDBOX_CLIENT,
} from "./sandbox/opensandbox-client";
import { LocalRuntimeProvider } from "./local/local-runtime.provider";
import { DockerRuntimeProvider } from "./sandbox/docker-runtime.provider";
import { OpenSandboxRuntimeProvider } from "./sandbox/opensandbox-runtime.provider";
import { RUNTIME_PROVIDERS } from "./runtime.types";
import type { RuntimeProvider } from "./runtime.types";

import { RuntimeService } from "./runtime.service";

// external deps
import { ConfigService } from "../config/config.service";

/**
 * Runtime 领域:三个 peer RuntimeProvider(local / docker / opensandbox),各自
 * 自声明 type、自实现 start/stop/destroy。不认识 WorkerRegistry、owner 复用规则、
 * idle 决策,不碰 DB——是零依赖模块,唯一的调用方是 `worker-manager`。
 */
@Module({
  providers: [
    {
      provide: OPENSANDBOX_CLIENT,
      useFactory: (configService: ConfigService) =>
        new OpenSandboxClient(configService),
      inject: [ConfigService],
    },
    LocalRuntimeProvider,
    DockerRuntimeProvider,
    OpenSandboxRuntimeProvider,
    {
      provide: RUNTIME_PROVIDERS,
      useFactory: (...providers: RuntimeProvider[]) => providers,
      inject: [
        LocalRuntimeProvider,
        DockerRuntimeProvider,
        OpenSandboxRuntimeProvider,
      ],
    },
    RuntimeService,
  ],
  exports: [
    // 公开面:根 Service 是 runtime 唯一稳定对外入口。
    RuntimeService,
  ],
})
export class RuntimeModule {}
