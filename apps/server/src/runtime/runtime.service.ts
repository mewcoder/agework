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
  type RuntimeEnvHandle,
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

  /** 准备目标 runtimeType 的执行环境(容器/进程),交由对应 RuntimeProvider 处理。 */
  prepareEnvironment(ctx: RuntimeLaunchContext): Promise<RuntimeEnvHandle> {
    return Promise.resolve(
      this.resolveProvider(ctx.runtimeType).prepareEnvironment(ctx)
    );
  }

  /** 在已准备好的环境上拉起 worker。 */
  launchWorker(
    ctx: RuntimeLaunchContext,
    env: RuntimeEnvHandle
  ): Promise<{ runtimeInstanceId: string }> {
    return Promise.resolve(
      this.resolveProvider(ctx.runtimeType).launchWorker(ctx, env)
    );
  }

  /** 拆除指定的运行时实例。 */
  teardown(ref: RuntimeInstanceRef): Promise<void> | void {
    return this.resolveProvider(ref.runtimeType).teardown(ref);
  }

  /** 回收一个孤儿运行时实例(若对应 provider 未实现回收则为 no-op)。 */
  recoverOrphan(ref: RuntimeInstanceRef): Promise<void> | void {
    return this.resolveProvider(ref.runtimeType).recoverOrphan?.(ref);
  }

  private resolveProvider(type: string): RuntimeProvider {
    const provider = this.providers.get(type);
    if (!provider) {
      throw new Error(`Unknown runtime provider: ${type}`);
    }
    return provider;
  }
}
