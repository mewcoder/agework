import { Injectable } from "@nestjs/common";
import { isAbsolute, relative, sep } from "node:path";
import type { RuntimePlacement } from "@agework/shared/protocol";
import {
  ConfigService,
  type IsolationScope,
  type RuntimeType,
} from "../../config/config.service";
import { CONTAINER_WORKSPACES_ROOT } from "../../config/defaults";

@Injectable()
export class RuntimePlacementPolicy {
  constructor(private readonly configService: ConfigService) {}

  resolveForRun(input: {
    userId: string;
    workspaceId: string;
    workspaceRootPath: string;
    userWorkspaceRootPath: string;
    runtimeType?: RuntimeType;
    isolationScope?: IsolationScope;
    /** workspace 持久化的 sandboxEngine，不传则从 ConfigService 读取 */
    sandboxEngine?: string;
  }): RuntimePlacement {
    const { userId, workspaceId, workspaceRootPath, userWorkspaceRootPath } = input;

    if (!isAbsolute(workspaceRootPath) || !isAbsolute(userWorkspaceRootPath)) {
      throw new Error(
        `workspaceRootPath and userWorkspaceRootPath must be absolute paths: workspaceRootPath=${workspaceRootPath}, userWorkspaceRootPath=${userWorkspaceRootPath}`
      );
    }

    const runtimeType = input.runtimeType ?? this.configService.getDefaultRuntimeType();
    const isolationScope =
      input.isolationScope ??
      this.configService.getDefaultIsolationScope();
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
        ? ((input.sandboxEngine ?? this.configService.getSandboxEngine()) as "docker" | "opensandbox")
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
      const runtimePath = [CONTAINER_WORKSPACES_ROOT, ...relativeSegments].join("/");
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
