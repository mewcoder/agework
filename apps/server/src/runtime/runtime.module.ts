import { Module } from "@nestjs/common";
import { createRuntimeProviders } from "@agework/runtime";

import { RuntimeService, RUNTIME_PROVIDERS } from "./runtime.service";
import { toRuntimeConfig } from "./runtime-config";
import { ConfigService } from "../config/config.service";

/**
 * Runtime 领域的接线层:从 ConfigService 拼出 RuntimeConfig,交给 `@agework/runtime`
 * 的工厂装配出 type → provider 映射表,RuntimeService 据此分发。provider 实现与契约
 * 全在包里,server 这边只剩这层薄接线 + 门面 Service。
 */
@Module({
  providers: [
    {
      provide: RUNTIME_PROVIDERS,
      useFactory: (configService: ConfigService) =>
        createRuntimeProviders(toRuntimeConfig(configService)),
      inject: [ConfigService],
    },
    RuntimeService,
  ],
  exports: [RuntimeService],
})
export class RuntimeModule {}
