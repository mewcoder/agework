import { isAbsolute } from "node:path";
import type { SandboxRuntimeSpec } from "@agework/shared/protocol";
import { safePathPart } from "./util";
import type {
  RuntimeConfig,
  RuntimeLaunchContext,
  SandboxPlacement,
  SandboxStartInput,
} from "../types";

const HOST_GATEWAY = "host.docker.internal";

/**
 * 容器内的 127.0.0.1/localhost 指向容器自身,回连不到宿主上的 server。sandbox
 * runtime(docker/opensandbox)把 loopback host 换成宿主网关名 host.docker.internal。
 * 非 loopback 地址(远程覆盖的真实 IP/域名)原样返回。
 */
function assertAbsoluteMountPath(hostPath: string): void {
  if (!isAbsolute(hostPath)) {
    throw new Error(`Sandbox mount path must be absolute: ${hostPath}`);
  }
}

function toContainerReachableUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") {
      parsed.hostname = HOST_GATEWAY;
      return parsed.toString();
    }
  } catch {
    // 非法 URL 原样透传,交由下游暴露
  }
  return url;
}

/**
 * 由一次 RuntimeLaunchContext + runtime config 算出容器 provider(docker /
 * opensandbox)共享的启动输入:合并 worker 协议 env + infra env、归属 metadata、
 * workspace/日志挂载路径。纯函数,docker 与 opensandbox 两个 provider 都调它。
 * serverBaseUrl 里的 loopback host 在此换成 host.docker.internal(见上)。
 */
export function buildSandboxStartInput(
  ctx: RuntimeLaunchContext,
  cfg: RuntimeConfig
): SandboxStartInput {
  const placement = ctx.placement as SandboxRuntimeSpec;
  // 挂载路径校验在共享构造点做一次,docker / opensandbox 不再各自把关。
  if (placement.hostPath) {
    assertAbsoluteMountPath(placement.hostPath);
  }
  if (cfg.runtimeLogHostPath) {
    assertAbsoluteMountPath(cfg.runtimeLogHostPath);
  }
  const runtimeLogDir = placement.runtimeLogDir;
  const serverBaseUrl = toContainerReachableUrl(cfg.serverBaseUrl);
  const sandboxPlacement: SandboxPlacement = {
    isolationScope: placement.sandbox.isolationScope,
    ownerId: ctx.ownerId,
    workspaceId: ctx.workspaceId,
    workspaceHostPath: placement.hostPath,
    workspaceMountPath: placement.sandbox.mountTarget,
  };
  return {
    placement: sandboxPlacement,
    image: cfg.workerImage,
    apiBaseUrl: serverBaseUrl,
    env: {
      ...ctx.workerEnv,
      AGEWORK_WORKER_API_BASE: serverBaseUrl,
      AGEWORK_WORKER_RUNTIME_RESOURCE_NAME: `agework-worker-${safePathPart(ctx.ownerId)}`,
      AGEWORK_WORKER_LOG_DIR: runtimeLogDir,
      AGEWORK_WORKER_LOG_FILE: `${runtimeLogDir}/${safePathPart(ctx.ownerId)}.runtime.worker.log`,
    },
    metadata: {
      "agework.io/runtime-owner-id": ctx.ownerId,
      "agework.io/isolation-scope": placement.sandbox.isolationScope,
    },
    runtimeLogHostPath: cfg.runtimeLogHostPath,
    runtimeLogMountPath: runtimeLogDir,
    expectedRuntimeInstanceId: ctx.expectedRuntimeInstanceId,
  };
}
