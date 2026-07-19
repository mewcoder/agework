import { isAbsolute, relative, sep } from "node:path";
import type {
  NativeRuntimeSpec,
  RuntimeSpec,
  SandboxRuntimeSpec,
  RuntimeSpecInput,
} from "./types";

// 容器内的固定路径约定(runtime 自己的常量,不是 server config)。
const CONTAINER_HOME = "/home/agework";
const CONTAINER_WORKSPACES_ROOT = `${CONTAINER_HOME}/workspaces`;
const CONTAINER_RUNTIME_LOG_DIR = `${CONTAINER_HOME}/.agework/logs/runtime`;

/** workspace 怎么挂进 runtime:host↔runtime 路径翻译 + 挂载点。mountTarget 仅 sandbox。 */
type WorkspaceMount = {
  hostPath: string;
  runtimePath: string;
  runtimeLogDir: string;
  mountTarget?: string;
};

/**
 * 空间映射:把宿主机 workspace 路径翻译成运行环境内的路径 + 挂载点(含绝对路径 /
 * user scope 落点校验)。这是本模块的重头逻辑,只管"挂在哪",不碰归属。
 */
function resolveWorkspaceMount(input: RuntimeSpecInput): WorkspaceMount {
  const { workspaceRootPath, userWorkspaceRootPath } = input;

  if (!isAbsolute(workspaceRootPath) || !isAbsolute(userWorkspaceRootPath)) {
    throw new Error(
      `workspaceRootPath and userWorkspaceRootPath must be absolute paths: workspaceRootPath=${workspaceRootPath}, userWorkspaceRootPath=${userWorkspaceRootPath}`
    );
  }

  // native:无容器,runtimePath === hostPath,日志目录直接用宿主机目录。
  // V3: scope 始终存在,native 通过 runtimeType 判定,不再用 scope === undefined。
  if (input.runtimeType === "native") {
    return {
      hostPath: workspaceRootPath,
      runtimePath: workspaceRootPath,
      runtimeLogDir: input.runtimeLogHostPath,
    };
  }

  // sandbox / user scope:整个用户根挂进共享容器,workspace 按相对用户根的子路径定位。
  if (input.scope === "user") {
    const rel = relative(userWorkspaceRootPath, workspaceRootPath);
    if (!isInsideUserRoot(rel)) {
      throw new Error(
        `workspaceRootPath must be inside userWorkspaceRootPath for sandbox user scope: workspaceRootPath=${workspaceRootPath}, userWorkspaceRootPath=${userWorkspaceRootPath}`
      );
    }
    const segments = rel.split(sep).filter(Boolean);
    return {
      hostPath: userWorkspaceRootPath,
      runtimePath: [CONTAINER_WORKSPACES_ROOT, ...segments].join("/"),
      mountTarget: CONTAINER_WORKSPACES_ROOT,
      runtimeLogDir: CONTAINER_RUNTIME_LOG_DIR,
    };
  }

  // sandbox / workspace scope:每个 workspace 独占容器,挂载与运行路径都是 <root>/<workspaceId>。
  const mountTarget = `${CONTAINER_WORKSPACES_ROOT}/${input.workspaceId}`;
  return {
    hostPath: workspaceRootPath,
    runtimePath: mountTarget,
    mountTarget,
    runtimeLogDir: CONTAINER_RUNTIME_LOG_DIR,
  };
}

/**
 * 组装一次 run 的目标运行环境:空间映射(resolveWorkspaceMount)拼成 RuntimeSpec。
 * 纯计算,不启动也不 attach worker。归属身份(isolation)由 Runtime Host 从
 * placement 派生后注入 RuntimeLaunchContext,不再进入 RuntimeSpec。
 */
export function resolveRuntimeSpec(input: RuntimeSpecInput): RuntimeSpec {
  const mount = resolveWorkspaceMount(input);
  const { userId, workspaceId } = input;

  if (input.runtimeType === "native") {
    const native: NativeRuntimeSpec = {
      runtimeType: "native",
      userId,
      workspaceId,
      hostPath: mount.hostPath,
      runtimePath: mount.runtimePath,
      runtimeLogDir: mount.runtimeLogDir,
    };
    return native;
  }

  const spec: SandboxRuntimeSpec = {
    runtimeType: input.runtimeType,
    userId,
    workspaceId,
    hostPath: mount.hostPath,
    runtimePath: mount.runtimePath,
    runtimeLogDir: mount.runtimeLogDir,
    sandbox: {
      scope: input.scope,
      // sandbox 分支 resolveWorkspaceMount 必定填了 mountTarget。
      mountTarget: mount.mountTarget as string,
    },
  };
  return spec;
}

/** workspace 目录是否落在用户根目录内(同目录或子目录)。 */
function isInsideUserRoot(relativePath: string): boolean {
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !isAbsolute(relativePath))
  );
}
