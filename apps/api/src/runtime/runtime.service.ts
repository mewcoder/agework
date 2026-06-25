import { Injectable } from "@nestjs/common";
import type {
  RuntimePlacement,
  RuntimeResourceHandle,
} from "@agework/shared/protocol";
import { RuntimePlacementPolicy } from "./core/runtime-resources/runtime-placement.policy";
import { runtimeResourceHandleFromPlacement } from "./core/runtime-resources/runtime-resource-handle";
import { RuntimeProviderRegistry } from "./providers/runtime-provider-registry";
import type { RuntimeResourceProvider } from "./providers/runtime-provider-contracts";

type ResolvePlacementInput = Parameters<
  RuntimePlacementPolicy["resolveForRun"]
>[0];

function hasRuntimeResourceProvision(
  provider: unknown
): provider is RuntimeResourceProvider {
  return typeof (provider as { provision?: unknown }).provision === "function";
}

/**
 * Runtime 层对上层的门面：只负责运行环境——解析 placement、provision/复用 runtime
 * resource、管理 resource 生命周期（心跳 / shutdown）。它不拥有「执行」：worker 的启动与
 * per-run control 由 Run 层的 RunWorkerExecutionService 驱动 provider 完成。
 */
@Injectable()
export class RuntimeService {
  constructor(
    private readonly placementPolicy: RuntimePlacementPolicy,
    private readonly providerRegistry: RuntimeProviderRegistry
  ) {}

  resolvePlacement(input: ResolvePlacementInput): RuntimePlacement {
    return this.placementPolicy.resolveForRun(input);
  }

  /**
   * Call provider-side provision when implemented; otherwise
   * derive the target runtime resource identity without starting or attaching a
   * worker.
   */
  async provision(placement: RuntimePlacement): Promise<RuntimeResourceHandle> {
    const provider = this.providerRegistry.resolve(placement.runtimeType);
    if (hasRuntimeResourceProvision(provider)) {
      return provider.provision(placement);
    }
    return runtimeResourceHandleFromPlacement(placement);
  }

  /**
   * 按 runtime resource key 喂容器级 watchdog。worker 只知道 resourceKey、不知道
   * 是哪个 provider 在持有它，因此广播给所有 provider；未持有该 key 的 provider 自然 no-op。
   */
  heartbeatRuntimeResource(resourceKey: string): void {
    for (const provider of this.providerRegistry.all()) {
      provider.heartbeatRuntimeResource?.(resourceKey);
    }
  }

  /** 停止并删除指定 runtime resource 对应的持久容器/沙箱。 */
  shutdownRuntimeResource(runtimeType: string, resourceKey: string): void {
    this.providerRegistry
      .resolve(runtimeType)
      .shutdownRuntimeResource?.(resourceKey);
  }
}
