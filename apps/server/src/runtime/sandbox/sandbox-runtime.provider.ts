import { Inject, Injectable, Logger } from "@nestjs/common";
import type {
  RuntimeProvider,
  RuntimeLaunchContext,
  RuntimeEnvHandle,
  RuntimeInstanceRef,
} from "../runtime.types";
import { SANDBOX_ENGINES, type SandboxEngine } from "./sandbox-engine";
import type {
  SandboxEngineType,
  SandboxPlacement,
  SandboxStartInput,
} from "../runtime.types";
import type { SandboxRuntimePlacement } from "@agework/shared/protocol";
import { ConfigService } from "../../config/config.service";
import { DEFAULT_WORKER_IMAGE } from "../../config/registry/defaults";
import { resolveDockerApiBase } from "./sandbox-utils";
import { safePathPart } from "../../common/safe-path";
import { swallow } from "../../common/swallow";

@Injectable()
export class SandboxRuntimeProvider implements RuntimeProvider {
  readonly type = "sandbox";
  readonly placementKind = "container" as const;
  private readonly logger = new Logger(SandboxRuntimeProvider.name);
  private readonly engines: Map<SandboxEngineType, SandboxEngine>;
  private readonly ownerEngine = new Map<string, SandboxEngineType>();

  constructor(
    private readonly configService: ConfigService,
    @Inject(SANDBOX_ENGINES) engines: SandboxEngine[]
  ) {
    this.engines = new Map(engines.map((e) => [e.type, e]));
  }

  async prepareEnvironment(
    ctx: RuntimeLaunchContext
  ): Promise<RuntimeEnvHandle> {
    const placement = ctx.placement as SandboxRuntimePlacement;
    const engineType = placement.sandbox.sandboxEngineType;
    const engine = this.resolveEngine(engineType);
    const input = this.buildSandboxStartInput(ctx, placement, engineType);
    const runtime = await engine.getOrCreate(input);
    await engine.startWorker(runtime, input);
    this.ownerEngine.set(ctx.ownerId, engineType);
    return { runtimeInstanceId: runtime.runtimeInstanceId };
  }

  launchWorker(
    _ctx: RuntimeLaunchContext,
    env: RuntimeEnvHandle
  ): Promise<{ runtimeInstanceId: string }> {
    return Promise.resolve({ runtimeInstanceId: env.runtimeInstanceId ?? "" });
  }

  async teardown(ref: RuntimeInstanceRef): Promise<void> {
    const engineType = this.ownerEngine.get(ref.ownerId);
    const engines = engineType
      ? [this.resolveEngine(engineType)]
      : [...this.engines.values()];
    for (const engine of engines) {
      await engine
        .stop(ref.runtimeInstanceId)
        .catch(swallow(this.logger, `stop sandbox ${ref.runtimeInstanceId}`));
    }
    this.ownerEngine.delete(ref.ownerId);
  }

  private resolveEngine(engineType: SandboxEngineType): SandboxEngine {
    const engine = this.engines.get(engineType);
    if (!engine) throw new Error(`Unknown sandbox engine: ${engineType}`);
    return engine;
  }

  private buildSandboxStartInput(
    ctx: RuntimeLaunchContext,
    placement: SandboxRuntimePlacement,
    engineType: SandboxEngineType
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
        AGEWORK_WORKER_SANDBOX_ENGINE: engineType,
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
