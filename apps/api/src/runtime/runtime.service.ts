import { Injectable } from "@nestjs/common";
import type { RuntimeResource } from "@agework/shared/protocol";
import { ConfigService } from "../config/config.service";
import {
  resolveRuntimeResource,
  type ResolveRuntimeResourceInput,
  type RuntimeResourceDefaults,
} from "./resources/runtime-resource";
import { RuntimeProviderRegistry } from "./providers/provider-registry";

/**
 * Runtime 层对上层的门面：只负责运行环境——解析 runtime resource、管理 resource 生命周期
 * （心跳 / shutdown）。它不拥有「执行」：worker 的启动与 per-run control 由 Run 层的
 * RunWorkerExecutionService 驱动 provider 完成。
 */
@Injectable()
export class RuntimeService {
  private readonly defaults: RuntimeResourceDefaults;

  constructor(
    configService: ConfigService,
    private readonly providerRegistry: RuntimeProviderRegistry
  ) {
    this.defaults = {
      runtimeType: configService.getDefaultRuntimeType(),
      isolationScope: configService.getDefaultIsolationScope(),
      sandboxEngine: configService.getSandboxEngine(),
    };
  }

  /** 从 run 输入解析出目标运行环境（纯计算，不启动 worker）。 */
  resolveRuntimeResource(input: ResolveRuntimeResourceInput): RuntimeResource {
    return resolveRuntimeResource(input, this.defaults);
  }

  /**
   * 按 runtime resource key 喂容器级 watchdog。worker 只知道 resourceKey、不知道
   * 是哪个 provider 在持有它，因此广播给所有 provider；未持有该 key 的 provider 自然 no-op。
   */
  heartbeatRuntimeInstance(resourceKey: string): void {
    for (const provider of this.providerRegistry.all()) {
      provider.heartbeatRuntimeInstance?.(resourceKey);
    }
  }

  /** 停止并删除指定 runtime resource 对应的持久容器/沙箱。 */
  shutdownRuntimeInstance(runtimeType: string, resourceKey: string): void {
    this.providerRegistry
      .resolve(runtimeType)
      .shutdownRuntimeInstance?.(resourceKey);
  }
}
