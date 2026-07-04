import { Inject, Injectable } from "@nestjs/common";
import type { RuntimeTarget } from "@agework/shared/protocol";
import { ConfigService } from "../config/config.service";
import {
  resolveRuntimeTarget,
  type ResolveRuntimeTargetInput,
} from "./placement/runtime-resource";
import {
  RUNTIME_PROVIDERS,
  type RuntimeProvider,
  type RuntimeLaunchContext,
  type RuntimeInstanceRef,
} from "./runtime.types";

/**
 * Runtime 层对上层的门面:按 runtimeType 分发给对应的 RuntimeProvider + placement 计算。
 * 不认识 WorkerRegistry、owner 复用规则、idle 决策——那些是 worker-manager 的事(设计文档 1.1/3.6 节)。
 * `runtime` 因此是零依赖模块,唯一调用方是 `worker-manager`。
 */
@Injectable()
export class RuntimeService {
  private readonly providers: Map<string, RuntimeProvider>;

  constructor(
    private readonly configService: ConfigService,
    @Inject(RUNTIME_PROVIDERS) providers: RuntimeProvider[]
  ) {
    this.providers = new Map(providers.map((p) => [p.type, p]));
  }

  /** 从 run 输入解析出目标运行环境(纯计算,不启动 worker;默认值由 run 层补齐)。 */
  resolveRuntimeTarget(input: ResolveRuntimeTargetInput): RuntimeTarget {
    return resolveRuntimeTarget(input);
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

  /** 建环境 + 起 worker,返回运行时实例 id。交由对应 RuntimeProvider 处理。 */
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

  private resolveProvider(type: string): RuntimeProvider {
    const provider = this.providers.get(type);
    if (!provider) {
      throw new Error(`Unknown runtime provider: ${type}`);
    }
    return provider;
  }
}
