import { Injectable } from "@nestjs/common";
import {
  createRuntimeResolver,
  type RuntimeProvider,
  type RuntimeType,
  type RuntimeLaunchContext,
  type RuntimeInstanceRef,
} from "@agework/providers";
import { ConfigService } from "../../config/config.service";
import type { Runtime } from "../runtime.types";
import { toRuntimeConfig } from "./runtime-config";

/**
 * `Runtime` 接口的 Managed(in-process)实现:按 runtimeType 分发给 `@agework/providers`
 * 装配好的 provider。provider 实现全在包内,这里经 resolver 拿到 RuntimeProvider 接口
 * 实例,不认识具体 provider 类。
 */
@Injectable()
export class LocalRuntime implements Runtime {
  /** 建一次、进程内长活的 provider resolver(get/throw 收在包闭包内)。 */
  private readonly resolveProvider: (type: RuntimeType) => RuntimeProvider;

  constructor(configService: ConfigService) {
    this.resolveProvider = createRuntimeResolver(
      toRuntimeConfig(configService)
    );
  }

  start(ctx: RuntimeLaunchContext): Promise<{ runtimeInstanceId: string }> {
    return this.resolveProvider(ctx.runtimeType).start(ctx);
  }

  stop(ref: RuntimeInstanceRef): Promise<void> | void {
    return this.resolveProvider(ref.runtimeType).stop(ref);
  }

  destroy(ref: RuntimeInstanceRef): Promise<void> | void {
    return this.resolveProvider(ref.runtimeType).destroy(ref);
  }
}
