import { Injectable } from "@nestjs/common";
import { isAbsolute, relative, sep } from "node:path";
import type {
  ResolvedRuntimeResource,
  RuntimePlacement,
} from "@agework/shared/protocol";
import {
  ConfigService,
  type IsolationScope,
  type RuntimeType,
} from "../config/config.service";
import { CONTAINER_WORKSPACES_ROOT } from "../config/defaults";
import { resolvedRuntimeResourceFromPlacement } from "./resources/resolved-runtime-resource";
import { RuntimeProviderRegistry } from "./providers/provider-registry";

type ResolvePlacementInput = {
  userId: string;
  workspaceId: string;
  workspaceRootPath: string;
  userWorkspaceRootPath: string;
  runtimeType?: RuntimeType;
  isolationScope?: IsolationScope;
  /** workspace 持久化的 sandboxEngine，不传则从 ConfigService 读取 */
  sandboxEngine?: string;
};

/**
 * Runtime 层对上层的门面：只负责运行环境——从 run 输入解析出 runtime resource、管理
 * resource 生命周期（心跳 / shutdown）。它不拥有「执行」：worker 的启动与 per-run
 * control 由 Run 层的 RunWorkerExecutionService 驱动 provider 完成。
 */
@Injectable()
export class RuntimeService {
  constructor(
    private readonly configService: ConfigService,
    private readonly providerRegistry: RuntimeProviderRegistry
  ) {}

  /**
   * 从 run 输入解析放置方案，并据此算出目标 runtime resource 身份。纯计算：不启动也不
   * attach worker。（未来若 sandbox 需要在此阶段 eager 建容器，再把这步拆成异步 provision。）
   */
  resolveRuntimeResource(input: ResolvePlacementInput): ResolvedRuntimeResource {
    const placement = this.resolvePlacement(input);
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

  /**
   * 放置策略（纯计算）：根据 run 输入与部署配置算出 runtime 类型、隔离粒度、沙箱引擎，
   * 以及宿主机/执行环境内的路径映射。不产生副作用、不碰容器。
   */
  private resolvePlacement(input: ResolvePlacementInput): RuntimePlacement {
    const { userId, workspaceId, workspaceRootPath, userWorkspaceRootPath } =
      input;

    if (!isAbsolute(workspaceRootPath) || !isAbsolute(userWorkspaceRootPath)) {
      throw new Error(
        `workspaceRootPath and userWorkspaceRootPath must be absolute paths: workspaceRootPath=${workspaceRootPath}, userWorkspaceRootPath=${userWorkspaceRootPath}`
      );
    }

    const runtimeType =
      input.runtimeType ?? this.configService.getDefaultRuntimeType();
    const isolationScope =
      input.isolationScope ?? this.configService.getDefaultIsolationScope();
    const relativePath = relative(userWorkspaceRootPath, workspaceRootPath);
    const isInsideUserWorkspaceRoot =
      relativePath === "" ||
      (!relativePath.startsWith("..") && !isAbsolute(relativePath));

    if (
      runtimeType === "sandbox" &&
      isolationScope === "user" &&
      !isInsideUserWorkspaceRoot
    ) {
      throw new Error(
        `workspaceRootPath must be inside userWorkspaceRootPath for sandbox user isolation: workspaceRootPath=${workspaceRootPath}, userWorkspaceRootPath=${userWorkspaceRootPath}`
      );
    }

    const sandboxEngineType =
      runtimeType === "sandbox"
        ? ((input.sandboxEngine ?? this.configService.getSandboxEngine()) as
            | "docker"
            | "opensandbox")
        : undefined;

    // 容器/沙箱内的挂载目标路径：user 隔离下该用户的所有 workspace 共享挂载到
    // CONTAINER_WORKSPACES_ROOT；workspace 隔离下该容器只服务单个 workspace，
    // 挂载到 CONTAINER_WORKSPACES_ROOT/<workspaceId>。
    const mountTarget =
      isolationScope === "user"
        ? CONTAINER_WORKSPACES_ROOT
        : `${CONTAINER_WORKSPACES_ROOT}/${workspaceId}`;

    if (runtimeType === "local") {
      return {
        runtimeType,
        userId,
        workspaceId,
        hostPath: workspaceRootPath,
        runtimePath: workspaceRootPath,
      };
    }

    if (isolationScope === "user") {
      const relativeSegments = relativePath.split(sep).filter(Boolean);
      const runtimePath = [CONTAINER_WORKSPACES_ROOT, ...relativeSegments].join(
        "/"
      );
      return {
        runtimeType,
        userId,
        workspaceId,
        hostPath: userWorkspaceRootPath,
        runtimePath,
        sandbox: {
          isolationScope,
          mountTarget,
          sandboxEngineType: sandboxEngineType!,
        },
      };
    }

    return {
      runtimeType,
      userId,
      workspaceId,
      hostPath: workspaceRootPath,
      runtimePath: mountTarget,
      sandbox: {
        isolationScope,
        mountTarget,
        sandboxEngineType: sandboxEngineType!,
      },
    };
  }
}
