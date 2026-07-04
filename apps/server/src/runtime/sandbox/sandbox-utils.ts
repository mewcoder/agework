import type { SandboxRuntimePlacement } from "@agework/shared/protocol";
import { resolveApiBasePath } from "../../common/path.util";
import { EnvKey } from "../../config/registry/env-key";
import { DEFAULT_WORKER_IMAGE } from "../../config/registry/defaults";
import { safePathPart } from "../../common/safe-path";
import type {
  RuntimeLaunchContext,
  SandboxPlacement,
  SandboxStartInput,
} from "../runtime.types";

/**
 * worker 容器访问宿主 API 的 base URL。
 * 默认指向 `host.docker.internal:<PORT>`,并拼上与 main.ts 一致的 API 挂载前缀
 * (`<AGEWORK_CONTEXT>/api/v1`),因为 internal runtime API 也在全局前缀之下。
 */
export function resolveDockerApiBase(
  env: Partial<
    Pick<NodeJS.ProcessEnv, "PORT" | "AGEWORK_CONTEXT">
  > = process.env
): string {
  const port = env[EnvKey.PORT] ?? "3000";
  return `http://host.docker.internal:${port}${resolveApiBasePath(
    env[EnvKey.CONTEXT]
  )}`;
}

/**
 * 由一次 RuntimeLaunchContext 算出容器 provider(docker / opensandbox)共享的启动
 * 输入:合并 worker 协议 env + infra env、归属 metadata、workspace/日志挂载路径。
 * 纯函数,docker 与 opensandbox 两个 provider 都调它。
 */
export function buildSandboxStartInput(
  ctx: RuntimeLaunchContext,
  engineType: string,
  runtimeLogHostPath: string
): SandboxStartInput {
  const placement = ctx.placement as SandboxRuntimePlacement;
  const apiBase = resolveDockerApiBase();
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
    image: DEFAULT_WORKER_IMAGE,
    apiBaseUrl: apiBase,
    env: {
      ...ctx.workerEnv,
      AGEWORK_WORKER_API_BASE: apiBase,
      AGEWORK_WORKER_SANDBOX_ENGINE: engineType,
      AGEWORK_WORKER_RUNTIME_RESOURCE_NAME: `agework-worker-${safePathPart(ctx.ownerId)}`,
      AGEWORK_WORKER_LOG_DIR: runtimeLogDir,
      AGEWORK_WORKER_LOG_FILE: `${runtimeLogDir}/${safePathPart(ctx.ownerId)}.runtime.worker.log`,
    },
    metadata: {
      "agework.io/runtime-owner-id": ctx.ownerId,
      "agework.io/isolation-scope": placement.sandbox.isolationScope,
    },
    runtimeLogHostPath,
    runtimeLogMountPath: runtimeLogDir,
    isExpectedRuntimeInstance: ctx.isExpectedRuntimeInstance,
  };
}
