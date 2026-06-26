import { Injectable } from "@nestjs/common";
import type { RuntimeTarget } from "@agework/shared/protocol";
import { ConfigService } from "../config/config.service";
import {
  resolveRuntimeTarget,
  type ResolveRuntimeTargetInput,
  type RuntimeTargetDefaults,
} from "./placement/runtime-resource";
import { RuntimeProviderRegistry } from "./providers/provider-registry";

/**
 * Runtime 层对上层的门面：只负责运行环境——解析 runtime resource、管理 resource 生命周期
 * （shutdown）。它不拥有「执行」：worker 的启动与 per-run control 由 Run 层的
 * RunDriver 驱动 provider 完成。
 */
@Injectable()
export class RuntimeService {
  private readonly defaults: RuntimeTargetDefaults;

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
  resolveRuntimeTarget(input: ResolveRuntimeTargetInput): RuntimeTarget {
    return resolveRuntimeTarget(input, this.defaults);
  }

  /** 停止并删除指定 owner 对应的持久容器/沙箱。 */
  shutdownRuntimeInstance(runtimeType: string, ownerId: string): void {
    this.providerRegistry
      .resolve(runtimeType)
      .shutdownRuntimeInstance?.(ownerId);
  }
}
