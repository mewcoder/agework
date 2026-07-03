import { Logger } from "@nestjs/common";
import type {
  RuntimeProvider,
  RuntimeLaunchContext,
  RuntimeEnvHandle,
  RuntimeInstanceRef,
} from "../runtime.types";
import type { SandboxEngine } from "./sandbox-engine";
import type { SandboxPlacement, SandboxStartInput } from "../runtime.types";
import type { SandboxRuntimePlacement } from "@agework/shared/protocol";
import { ConfigService } from "../../config/config.service";
import { DEFAULT_WORKER_IMAGE } from "../../config/registry/defaults";
import { resolveDockerApiBase } from "./sandbox-utils";
import { safePathPart } from "../../common/safe-path";
import { swallow } from "../../common/swallow";

/** 容器运行形态的共享实现:docker / opensandbox 各持有一个 SandboxEngine 的子类。
 *  子类只声明 `type` 并由 DI 注入对应引擎。 */
export abstract class ContainerRuntimeProvider implements RuntimeProvider {
  abstract readonly type: string;
  readonly placementKind = "container" as const;
  protected readonly logger = new Logger(ContainerRuntimeProvider.name);

  constructor(
    protected readonly configService: ConfigService,
    protected readonly engine: SandboxEngine
  ) {}

  async prepareEnvironment(
    ctx: RuntimeLaunchContext
  ): Promise<RuntimeEnvHandle> {
    const placement = ctx.placement as SandboxRuntimePlacement;
    const input = this.buildSandboxStartInput(ctx, placement);
    const runtime = await this.engine.getOrCreate(input);
    await this.engine.startWorker(runtime, input);
    return { runtimeInstanceId: runtime.runtimeInstanceId };
  }

  launchWorker(
    _ctx: RuntimeLaunchContext,
    env: RuntimeEnvHandle
  ): Promise<{ runtimeInstanceId: string }> {
    return Promise.resolve({ runtimeInstanceId: env.runtimeInstanceId ?? "" });
  }

  async teardown(ref: RuntimeInstanceRef): Promise<void> {
    await this.engine
      .stop(ref.runtimeInstanceId)
      .catch(swallow(this.logger, `stop container ${ref.runtimeInstanceId}`));
  }

  private buildSandboxStartInput(
    ctx: RuntimeLaunchContext,
    placement: SandboxRuntimePlacement
  ): SandboxStartInput {
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
        AGEWORK_WORKER_SANDBOX_ENGINE: this.type,
        AGEWORK_WORKER_RUNTIME_RESOURCE_NAME: `agework-worker-${safePathPart(ctx.ownerId)}`,
        AGEWORK_WORKER_LOG_DIR: runtimeLogDir,
        AGEWORK_WORKER_LOG_FILE: `${runtimeLogDir}/${safePathPart(ctx.ownerId)}.runtime.worker.log`,
      },
      metadata: {
        "agework.io/runtime-owner-id": ctx.ownerId,
        "agework.io/isolation-scope": placement.sandbox.isolationScope,
      },
      runtimeLogHostPath: this.configService.getRuntimeLogDir(),
      runtimeLogMountPath: runtimeLogDir,
      isExpectedRuntimeInstance: ctx.isExpectedRuntimeInstance,
    };
  }
}
