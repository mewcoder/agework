import type { SandboxRuntimeSpec } from "@agework/shared/protocol";
import { safePathPart } from "./util";
import type {
  RuntimeLaunchContext,
  SandboxPlacement,
  SandboxProviderConfig,
  SandboxStartInput,
} from "../types";

/**
 * 由一次 RuntimeLaunchContext + provider config 算出容器 provider(docker /
 * opensandbox)共享的启动输入:合并 worker 协议 env + infra env、归属 metadata、
 * workspace/日志挂载路径。纯函数,docker 与 opensandbox 两个 provider 都调它。
 */
export function buildSandboxStartInput(
  ctx: RuntimeLaunchContext,
  cfg: SandboxProviderConfig
): SandboxStartInput {
  const placement = ctx.placement as SandboxRuntimeSpec;
  const runtimeLogDir = placement.runtimeLogDir;
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
    apiBaseUrl: cfg.apiBaseUrl,
    env: {
      ...ctx.workerEnv,
      AGEWORK_WORKER_API_BASE: cfg.apiBaseUrl,
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
    isExpectedRuntimeInstance: ctx.isExpectedRuntimeInstance,
  };
}
