import { Injectable } from "@nestjs/common";
import { isAbsolute, relative, sep } from "node:path";
import type {
  LocalRuntimePlacement,
  ResolvedRuntimeResource,
  RuntimePlacement,
  SandboxRuntimePlacement,
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
   * 放置策略（纯计算）：先解析 runtime 类型与隔离粒度，再分派到对应策略。
   * 三种策略各自决定宿主机/执行环境内的路径映射，互不耦合：
   *   local            —— 直接用宿主机 workspace 路径，无容器
   *   sandbox + user   —— 该用户所有 workspace 共享一个容器，按相对路径挂进容器
   *   sandbox + workspace —— 每个 workspace 独占容器，挂到 <root>/<workspaceId>
   * 不产生副作用、不碰容器。
   */
  private resolvePlacement(input: ResolvePlacementInput): RuntimePlacement {
    const { workspaceRootPath, userWorkspaceRootPath } = input;
    if (!isAbsolute(workspaceRootPath) || !isAbsolute(userWorkspaceRootPath)) {
      throw new Error(
        `workspaceRootPath and userWorkspaceRootPath must be absolute paths: workspaceRootPath=${workspaceRootPath}, userWorkspaceRootPath=${userWorkspaceRootPath}`
      );
    }

    const runtimeType =
      input.runtimeType ?? this.configService.getDefaultRuntimeType();
    if (runtimeType === "local") {
      return this.localPlacement(input);
    }

    const isolationScope =
      input.isolationScope ?? this.configService.getDefaultIsolationScope();
    return isolationScope === "user"
      ? this.sandboxUserPlacement(input)
      : this.sandboxWorkspacePlacement(input);
  }

  /** local：一律用宿主机 workspace 路径，runtimePath === hostPath。 */
  private localPlacement(input: ResolvePlacementInput): LocalRuntimePlacement {
    const { userId, workspaceId, workspaceRootPath } = input;
    return {
      runtimeType: "local",
      userId,
      workspaceId,
      hostPath: workspaceRootPath,
      runtimePath: workspaceRootPath,
    };
  }

  /**
   * sandbox + user：整个用户根目录挂进共享容器，挂载根为 CONTAINER_WORKSPACES_ROOT；
   * 该 workspace 在容器内的路径按其相对用户根的子路径拼接。要求 workspace 在用户根内。
   */
  private sandboxUserPlacement(
    input: ResolvePlacementInput
  ): SandboxRuntimePlacement {
    const { userId, workspaceId, workspaceRootPath, userWorkspaceRootPath } =
      input;
    const relativePath = relative(userWorkspaceRootPath, workspaceRootPath);
    if (!this.isInsideUserRoot(relativePath)) {
      throw new Error(
        `workspaceRootPath must be inside userWorkspaceRootPath for sandbox user isolation: workspaceRootPath=${workspaceRootPath}, userWorkspaceRootPath=${userWorkspaceRootPath}`
      );
    }
    const segments = relativePath.split(sep).filter(Boolean);
    return {
      runtimeType: "sandbox",
      userId,
      workspaceId,
      hostPath: userWorkspaceRootPath,
      runtimePath: [CONTAINER_WORKSPACES_ROOT, ...segments].join("/"),
      sandbox: {
        isolationScope: "user",
        mountTarget: CONTAINER_WORKSPACES_ROOT,
        sandboxEngineType: this.resolveSandboxEngine(input),
      },
    };
  }

  /** sandbox + workspace：该 workspace 独占容器，挂载与运行路径都是 <root>/<workspaceId>。 */
  private sandboxWorkspacePlacement(
    input: ResolvePlacementInput
  ): SandboxRuntimePlacement {
    const { userId, workspaceId, workspaceRootPath } = input;
    const mountTarget = `${CONTAINER_WORKSPACES_ROOT}/${workspaceId}`;
    return {
      runtimeType: "sandbox",
      userId,
      workspaceId,
      hostPath: workspaceRootPath,
      runtimePath: mountTarget,
      sandbox: {
        isolationScope: "workspace",
        mountTarget,
        sandboxEngineType: this.resolveSandboxEngine(input),
      },
    };
  }

  private resolveSandboxEngine(
    input: ResolvePlacementInput
  ): SandboxRuntimePlacement["sandbox"]["sandboxEngineType"] {
    return (input.sandboxEngine ??
      this.configService.getSandboxEngine()) as SandboxRuntimePlacement["sandbox"]["sandboxEngineType"];
  }

  /** workspace 目录是否落在用户根目录内（同目录或子目录）。 */
  private isInsideUserRoot(relativePath: string): boolean {
    return (
      relativePath === "" ||
      (!relativePath.startsWith("..") && !isAbsolute(relativePath))
    );
  }
}
