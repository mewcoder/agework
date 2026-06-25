import { isAbsolute, relative, sep } from "node:path";
import type {
  LocalRuntimePlacement,
  RuntimePlacement,
  RuntimeResource,
  SandboxRuntimePlacement,
} from "@agework/shared/protocol";
import type {
  IsolationScope,
  RuntimeType,
} from "../../config/config.service";
import { CONTAINER_WORKSPACES_ROOT } from "../../config/defaults";

export type ResolveRuntimeResourceInput = {
  userId: string;
  workspaceId: string;
  workspaceRootPath: string;
  userWorkspaceRootPath: string;
  runtimeType: RuntimeType;
  /** sandbox 必填；local 不消费 */
  isolationScope: IsolationScope;
  /** sandbox 必填；local 不消费 */
  sandboxEngine: "docker" | "opensandbox";
};

/** 类型守卫：narrow 出 sandbox 分支（placement.sandbox 必填）。 */
export function isSandboxPlacement(
  placement: RuntimePlacement
): placement is SandboxRuntimePlacement {
  return placement.runtimeType === "sandbox";
}

/**
 * 解析一次 run 的目标运行环境：根据 run 输入算出路径映射与容器复用键 resourceKey，
 * 直接返回一个 RuntimeResource 对象。纯计算，不启动也不 attach worker。
 * runtimeType / isolationScope / sandboxEngine 由调用方（RuntimeService）从配置填好默认值后传入。
 */
export function resolveRuntimeResource(
  input: ResolveRuntimeResourceInput
): RuntimeResource {
  const {
    userId,
    workspaceId,
    workspaceRootPath,
    userWorkspaceRootPath,
    runtimeType,
  } = input;

  if (!isAbsolute(workspaceRootPath) || !isAbsolute(userWorkspaceRootPath)) {
    throw new Error(
      `workspaceRootPath and userWorkspaceRootPath must be absolute paths: workspaceRootPath=${workspaceRootPath}, userWorkspaceRootPath=${userWorkspaceRootPath}`
    );
  }

  // local：直接用宿主机 workspace 路径，无容器，runtimePath === hostPath。
  // resourceKey 无复用语义，用 workspaceId 兜底。
  if (runtimeType === "local") {
    const local: LocalRuntimePlacement = {
      runtimeType: "local",
      userId,
      workspaceId,
      hostPath: workspaceRootPath,
      runtimePath: workspaceRootPath,
    };
    return { ...local, resourceKey: workspaceId };
  }

  const { isolationScope, sandboxEngine } = input;

  // sandbox 下隔离粒度只影响 hostPath / runtimePath / mountTarget：
  //   user      —— 整个用户根挂进共享容器（挂载根 = CONTAINER_WORKSPACES_ROOT），
  //                workspace 按相对用户根的子路径定位；要求 workspace 在用户根内。
  //   workspace —— 每个 workspace 独占容器，挂载与运行路径都是 <root>/<workspaceId>。
  let hostPath: string;
  let runtimePath: string;
  let mountTarget: string;
  let resourceKey: string;

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
    resourceKey = userId;
  } else {
    mountTarget = `${CONTAINER_WORKSPACES_ROOT}/${workspaceId}`;
    hostPath = workspaceRootPath;
    runtimePath = mountTarget;
    resourceKey = workspaceId;
  }

  const placement: SandboxRuntimePlacement = {
    runtimeType: "sandbox",
    userId,
    workspaceId,
    hostPath,
    runtimePath,
    sandbox: { isolationScope, mountTarget, sandboxEngineType: sandboxEngine },
  };
  return { ...placement, resourceKey };
}

/** workspace 目录是否落在用户根目录内（同目录或子目录）。 */
function isInsideUserRoot(relativePath: string): boolean {
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !isAbsolute(relativePath))
  );
}

/**
 * runtime resource key 的核心规则:隔离粒度决定容器按谁复用——
 * user→用户,workspace→工作区。这是唯一的判定处,下面两个 wrapper 只负责适配各自入参。
 */
export function runtimeResourceKey(
  isolationScope: string,
  userId: string,
  workspaceId: string
): string {
  if (isolationScope === "user") return userId;
  if (isolationScope === "workspace") return workspaceId;
  throw new Error(`Unknown runtime isolation scope: ${isolationScope}`);
}

/** 从持久化的 RuntimeResource owner 记录算 resource key（容器存活台账侧用）。 */
export function runtimeResourceKeyForOwner(input: {
  isolationScope: string;
  ownerUserId: string;
  ownerWorkspaceId: string | null;
}): string {
  if (input.isolationScope === "workspace" && !input.ownerWorkspaceId) {
    throw new Error("Runtime resource ownerWorkspaceId is required");
  }
  return runtimeResourceKey(
    input.isolationScope,
    input.ownerUserId,
    input.ownerWorkspaceId ?? ""
  );
}
