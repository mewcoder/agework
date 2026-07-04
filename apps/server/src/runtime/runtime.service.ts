import { Inject, Injectable } from "@nestjs/common";
import type { RuntimeSpec } from "@agework/shared/protocol";
import {
  resolveRuntimeSpec,
  type RuntimeProvider,
  type RuntimeType,
  type RuntimeLaunchContext,
  type RuntimeInstanceRef,
  type RuntimeSpecInput,
} from "@agework/runtime";
import { ConfigService } from "../config/config.service";

/** DI token:注入 createRuntimeProviders(cfg) 装配出的 type → provider 映射表。 */
export const RUNTIME_PROVIDERS = Symbol("RUNTIME_PROVIDERS");

/**
 * Runtime 层对上层的门面:按 runtimeType 分发给 `@agework/runtime` 装配好的 provider
 * + placement 计算 + 运行时策略。runtime provider 实现全在 `@agework/runtime` 包内,
 * server 只经工厂拿到 RuntimeProvider 接口实例,不认识具体 provider 类。
 */
@Injectable()
export class RuntimeService {
  constructor(
    private readonly configService: ConfigService,
    @Inject(RUNTIME_PROVIDERS)
    private readonly providers: Map<RuntimeType, RuntimeProvider>
  ) {}

  /** 从 run 输入解析出目标运行环境(纯计算,不启动 worker;默认值由 run 层补齐)。 */
  resolveRuntimeSpec(input: RuntimeSpecInput): RuntimeSpec {
    return resolveRuntimeSpec(input);
  }

  /** 返回当前运行时策略配置(默认/可选 runtimeType、isolationScope、空闲超时秒数),供前端展示与校验用。 */
  getRuntimePolicy() {
    return {
      runtimeType: this.configService.getDefaultRuntimeType(),
      allowedRuntimeTypes: this.configService.getAllowedRuntimeTypes(),
      isolationScope: this.configService.getDefaultIsolationScope(),
      allowedIsolationScopes: this.configService.getAllowedIsolationScopes(),
      idleTimeoutSeconds: this.configService.getIdleTimeoutSeconds(),
    };
  }

  /** 建环境 + 起 worker,返回运行时实例 id。 */
  start(ctx: RuntimeLaunchContext): Promise<{ runtimeInstanceId: string }> {
    return this.resolveProvider(ctx.runtimeType).start(ctx);
  }

  /** owner 仍在:停 worker,保留载体。 */
  stop(ref: RuntimeInstanceRef): Promise<void> | void {
    return this.resolveProvider(ref.runtimeType).stop(ref);
  }

  /** owner 永久消失:删除载体。 */
  destroy(ref: RuntimeInstanceRef): Promise<void> | void {
    return this.resolveProvider(ref.runtimeType).destroy(ref);
  }

  private resolveProvider(type: RuntimeType): RuntimeProvider {
    const provider = this.providers.get(type);
    if (!provider) {
      throw new Error(`Unknown runtime provider: ${type}`);
    }
    return provider;
  }
}
