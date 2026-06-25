import { Injectable } from "@nestjs/common";
import type { RuntimeResource } from "@agework/shared/protocol";
import {
  ConfigService,
  type IsolationScope,
  type RuntimeType,
} from "../config/config.service";
import {
  resolveRuntimeResource,
  type ResolveRuntimeResourceInput,
} from "./resources/runtime-resource";
import { RuntimeProviderRegistry } from "./providers/provider-registry";

/** run 层提供的原始输入（runtimeType / isolationScope / sandboxEngine 可选，由 service 填默认）。 */
export type ResolveRuntimeResourceRequest = {
  userId: string;
  workspaceId: string;
  workspaceRootPath: string;
  userWorkspaceRootPath: string;
  runtimeType?: RuntimeType;
  isolationScope?: IsolationScope;
  sandboxEngine?: "docker" | "opensandbox";
};

/**
 * Runtime 层对上层的门面：只负责运行环境——解析 runtime resource、管理 resource 生命周期
 * （心跳 / shutdown）。它不拥有「执行」：worker 的启动与 per-run control 由 Run 层的
 * RunWorkerExecutionService 驱动 provider 完成。
 */
@Injectable()
export class RuntimeService {
  constructor(
    private readonly configService: ConfigService,
    private readonly providerRegistry: RuntimeProviderRegistry
  ) {}

  /** 从 run 输入解析出目标运行环境（纯计算，不启动 worker）。 */
  resolveRuntimeResource(
    request: ResolveRuntimeResourceRequest
  ): RuntimeResource {
    const input: ResolveRuntimeResourceInput = {
      userId: request.userId,
      workspaceId: request.workspaceId,
      workspaceRootPath: request.workspaceRootPath,
      userWorkspaceRootPath: request.userWorkspaceRootPath,
      runtimeType:
        request.runtimeType ?? this.configService.getDefaultRuntimeType(),
      isolationScope:
        request.isolationScope ??
        this.configService.getDefaultIsolationScope(),
      sandboxEngine:
        request.sandboxEngine ?? this.configService.getSandboxEngine(),
    };
    return resolveRuntimeResource(input);
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
