import { isAbsolute, relative, sep } from "node:path";
import type {
  LocalRuntimePlacement,
  RuntimePlacement,
  RuntimeTarget,
  SandboxRuntimePlacement,
} from "@agework/shared/protocol";
import type {
  IsolationScope,
  RuntimeType,
} from "../config/config.service";
import { CONTAINER_WORKSPACES_ROOT } from "../config/registry/defaults";

export type ResolveRuntimeTargetInput = {
  userId: string;
  workspaceId: string;
  workspaceRootPath: string;
  userWorkspaceRootPath: string;
  /** 不传则用 defaults.runtimeType */
  runtimeType?: RuntimeType;
  /** sandbox 下不传则用 defaults.isolationScope；local 不消费 */
  isolationScope?: IsolationScope;
  /** sandbox 下不传则用 defaults.sandboxEngine；local 不消费 */
  sandboxEngine?: "docker" | "opensandbox";
};

/** 部署默认值（由 RuntimeService 从 ConfigService 取出后传入）。 */
export type RuntimeTargetDefaults = {
  runtimeType: RuntimeType;
  isolationScope: IsolationScope;
  sandboxEngine: "docker" | "opensandbox";
};

/** 类型守卫：narrow 出 sandbox 分支（placement.sandbox 必填）。 */
export function isSandboxPlacement(
  placement: RuntimePlacement
): placement is SandboxRuntimePlacement {
  return placement.runtimeType === "sandbox";
}

/**
 * 解析一次 run 的目标运行环境：根据 run 输入与部署默认值，算出 runtime 类型、隔离粒度、
 * 路径映射与容器归属 ownerId，直接返回一个 RuntimeTarget 对象。纯计算，不启动
 * 也不 attach worker。
 */
export function resolveRuntimeTarget(
  input: ResolveRuntimeTargetInput,
  defaults: RuntimeTargetDefaults
): RuntimeTarget {
  const {
    userId,
    workspaceId,
    workspaceRootPath,
    userWorkspaceRootPath,
  } = input;

  if (!isAbsolute(workspaceRootPath) || !isAbsolute(userWorkspaceRootPath)) {
    throw new Error(
      `workspaceRootPath and userWorkspaceRootPath must be absolute paths: workspaceRootPath=${workspaceRootPath}, userWorkspaceRootPath=${userWorkspaceRootPath}`
    );
  }

  const runtimeType = input.runtimeType ?? defaults.runtimeType;

  // local：直接用宿主机 workspace 路径，无容器，runtimePath === hostPath。
  // ownerId 无复用语义，用 workspaceId 兜底。
  if (runtimeType === "local") {
    const local: LocalRuntimePlacement = {
      runtimeType: "local",
      userId,
      workspaceId,
      hostPath: workspaceRootPath,
      runtimePath: workspaceRootPath,
    };
    return { ...local, ownerId: workspaceId };
  }

  const isolationScope = input.isolationScope ?? defaults.isolationScope;
  const sandboxEngine = input.sandboxEngine ?? defaults.sandboxEngine;

  // sandbox 下隔离粒度只影响 hostPath / runtimePath / mountTarget / ownerId：
  //   user      —— 整个用户根挂进共享容器（挂载根 = CONTAINER_WORKSPACES_ROOT），
  //                workspace 按相对用户根的子路径定位；要求 workspace 在用户根内。
  //                ownerId = userId（容器归属 user）。
  //   workspace —— 每个 workspace 独占容器，挂载与运行路径都是 <root>/<workspaceId>。
  //                ownerId = workspaceId（容器归属 workspace）。
  let hostPath: string;
  let runtimePath: string;
  let mountTarget: string;
  let ownerId: string;

  if (isolationScope === "user") {
    const rel = relative(userWorkspaceRootPath, workspaceRootPath);
    if (!isInsideUserRoot(rel)) {
      throw new Error(
        `workspaceRootPath must be inside userWorkspaceRootPath for sandbox user isolation: workspaceRootPath=${workspaceRootPath}, userWorkspaceRootPath=${userWorkspaceRootPath}`
      );
    }
    const segments = rel.split(sep).filter(Boolean);
    hostPath = userWorkspaceRootPath;
    runtimePath = [CONTAINER_WORKSPACES_ROOT, ...segments].join("/");
    mountTarget = CONTAINER_WORKSPACES_ROOT;
    ownerId = userId;
  } else {
    mountTarget = `${CONTAINER_WORKSPACES_ROOT}/${workspaceId}`;
    hostPath = workspaceRootPath;
    runtimePath = mountTarget;
    ownerId = workspaceId;
  }

  const placement: SandboxRuntimePlacement = {
    runtimeType: "sandbox",
    userId,
    workspaceId,
    hostPath,
    runtimePath,
    sandbox: { isolationScope, mountTarget, sandboxEngineType: sandboxEngine },
  };
  return { ...placement, ownerId };
}

/** workspace 目录是否落在用户根目录内（同目录或子目录）。 */
function isInsideUserRoot(relativePath: string): boolean {
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !isAbsolute(relativePath))
  );
}
