import { Injectable } from "@nestjs/common";
import type { ResolvedRuntimeResource } from "@agework/shared/protocol";
import { RuntimePlacementPolicy } from "./core/runtime-resources/runtime-placement.policy";
import { resolvedRuntimeResourceFromPlacement } from "./core/runtime-resources/runtime-resource-handle";
import { RuntimeProviderRegistry } from "./providers/runtime-provider-registry";

type ResolvePlacementInput = Parameters<
  RuntimePlacementPolicy["resolveForRun"]
>[0];

/**
 * Runtime 层对上层的门面：只负责运行环境——从 run 输入解析出 runtime resource、管理
 * resource 生命周期（心跳 / shutdown）。它不拥有「执行」：worker 的启动与 per-run
 * control 由 Run 层的 RunWorkerExecutionService 驱动 provider 完成。
 */
@Injectable()
export class RuntimeService {
  constructor(
    private readonly placementPolicy: RuntimePlacementPolicy,
    private readonly providerRegistry: RuntimeProviderRegistry
  ) {}

  /**
   * 从 run 输入解析放置方案，并据此算出目标 runtime resource 身份。纯计算：不启动也不
   * attach worker。（未来若 sandbox 需要在此阶段 eager 建容器，再把这步拆成异步 provision。）
   */
  resolveRuntimeResource(input: ResolvePlacementInput): ResolvedRuntimeResource {
    const placement = this.placementPolicy.resolveForRun(input);
    return resolvedRuntimeResourceFromPlacement(placement);
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
