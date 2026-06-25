import { Inject, Injectable, Logger } from "@nestjs/common";
import type {
  IsolationScope,
  ResolvedRuntimeResource,
  SandboxRuntimePlacement,
  WorkerExecutionHandle,
  WorkerExecutionStartInput,
} from "@agework/shared/protocol";
import { isSandboxPlacement } from "../../resources/resolved-runtime-resource";
import { ConfigService } from "../../../config/config.service";
import { CONTAINER_RUNTIME_LOG_DIR, DEFAULT_WORKER_IMAGE } from "../../../config/defaults";
import { RuntimeInternalAccessService } from "../../internal/access.service";
import { WorkspaceRuntimeRepository } from "../../resources/workspace-runtime.repository";
import { swallow } from "../../../common/swallow";
import {
  HeartbeatWatchdog,
  IdleWatchdog,
  resolveDockerApiBase,
} from "../provider-utils";
import type {
  SandboxEngine,
  SandboxEngineType,
  SandboxPlacement,
  SandboxRuntime,
  SandboxStartInput,
} from "./engine";
import { SANDBOX_ENGINES } from "./engine";
import { errorLogFields, safeLogJson } from "../../../common/logging";
import { safePathPart } from "../../../common/safe-path";

export type SandboxScopeState = {
  runtimeResourceId: string;
  /** 上次 idle/心跳超时释放时的容器 ID，供下次 start() resume；resume 成功或全新创建后清空。 */
  lastStoppedRuntimeResourceId?: string;
  accessKey: string;
  activeRuns: Map<string, string>;
  isolationScope: IsolationScope;
  engineType: SandboxEngineType;
};

export type SandboxWorkerExecutionContext = {
  runConfig: WorkerExecutionStartInput["runConfig"];
  runtimeResource: ResolvedRuntimeResource;
  placement: SandboxRuntimePlacement;
  runId: string;
  workspaceId: string;
  resourceKey: string;
  isolationScope: IsolationScope;
  engineType: SandboxEngineType;
  engine: SandboxEngine;
};

export type SandboxRuntimeResourceAttachment = {
  context: SandboxWorkerExecutionContext;
  scopeState: SandboxScopeState;
  handle: WorkerExecutionHandle;
  onRuntimeResourceIdReady?: (runtimeResourceId: string) => void;
};

export type SandboxRuntimeResourceCallbacks = {
  consumeCancelledStartingRun(runId: string): boolean;
  forceCancelled(runId: string): void;
  publishWorkerError(runId: string, error: string): void;
  cleanupWorkspace(resourceKey: string): void;
};

@Injectable()
export class SandboxRuntimeResourceService {
  private readonly logger = new Logger(SandboxRuntimeResourceService.name);

  private readonly scopeStates = new Map<string, SandboxScopeState>();
  private readonly pendingSandboxes = new Map<string, Promise<SandboxRuntime>>();
  private readonly heartbeats = new HeartbeatWatchdog();
  private readonly idleWatchdog = new IdleWatchdog();
  private readonly engines: Map<SandboxEngineType, SandboxEngine>;

  constructor(
    private readonly configService: ConfigService,
    private readonly workspaceRuntimeService: WorkspaceRuntimeRepository,
    private readonly runtimeAccess: RuntimeInternalAccessService,
    @Inject(SANDBOX_ENGINES) engines: SandboxEngine[]
  ) {
    this.engines = new Map(engines.map((e) => [e.type, e]));
  }

  resolveWorkerExecutionContext(
    input: WorkerExecutionStartInput
  ): SandboxWorkerExecutionContext {
    const placement = input.runtimeResource.placement;
    if (!isSandboxPlacement(placement)) {
      throw new Error(
        `SandboxRuntimeResourceService requires sandbox placement, got runtimeType=${placement.runtimeType}`
      );
    }
    const engineType =
      placement.sandbox.sandboxEngineType ?? this.configService.getSandboxEngine();
    return {
      runConfig: input.runConfig,
      runtimeResource: input.runtimeResource,
      placement,
      runId: input.runConfig.runId,
      workspaceId: input.runConfig.workspaceId,
      resourceKey: input.runtimeResource.resourceKey,
      isolationScope: placement.sandbox.isolationScope,
      engineType,
      engine: this.resolveEngine(engineType),
    };
  }

  createRunHandle(context: SandboxWorkerExecutionContext): WorkerExecutionHandle {
    return {
      runId: context.runId,
      runtimeType: context.runtimeResource.runtimeType,
      runtimeResourceId: context.runtimeResource.runtimeResourceId ?? "",
      conversationId: context.runConfig.conversationId,
    };
  }

  ensureScopeState(
    context: SandboxWorkerExecutionContext
  ): SandboxScopeState {
    let scopeState = this.scopeStates.get(context.resourceKey);
    if (!scopeState) {
      const accessKey = this.runtimeAccess.issueWorkspaceKey(
        context.resourceKey
      );
      scopeState = {
        runtimeResourceId: "",
        accessKey,
        activeRuns: new Map(),
        isolationScope: context.isolationScope,
        engineType: context.engineType,
      };
      this.scopeStates.set(context.resourceKey, scopeState);
      this.idleWatchdog.cancel(context.resourceKey);
      return scopeState;
    }

    if (
      !scopeState.runtimeResourceId &&
      !this.pendingSandboxes.has(context.resourceKey) &&
      !scopeState.lastStoppedRuntimeResourceId
    ) {
      scopeState.accessKey = this.runtimeAccess.issueWorkspaceKey(
        context.resourceKey
      );
      scopeState.engineType = context.engineType;
    }

    this.idleWatchdog.cancel(context.resourceKey);
    return scopeState;
  }

  attachOrStartRuntimeResource(
    attachment: SandboxRuntimeResourceAttachment,
    callbacks: SandboxRuntimeResourceCallbacks
  ): void {
    const { context, scopeState, handle } = attachment;
    if (scopeState.runtimeResourceId) {
      this.attachReadyRuntimeResource(attachment);
      return;
    }

    const existingPending = this.pendingSandboxes.get(context.resourceKey);
    if (existingPending) {
      this.attachPendingRuntimeResource(attachment, existingPending, callbacks);
      return;
    }

    handle.runtimeResourceId =
      context.runtimeResource.runtimeResourceId ?? handle.runtimeResourceId;
    this.startRuntimeResourceForScope(attachment, callbacks);
  }

  findScopeKeyByRun(runId: string): string | undefined {
    for (const [scopeKey, state] of this.scopeStates) {
      if (state.activeRuns.has(runId)) return scopeKey;
    }
    return undefined;
  }

  getScopeState(scopeKey: string): SandboxScopeState | undefined {
    return this.scopeStates.get(scopeKey);
  }

  getHandle(runId: string): WorkerExecutionHandle | undefined {
    const scopeKey = this.findScopeKeyByRun(runId);
    if (!scopeKey) return undefined;
    const state = this.scopeStates.get(scopeKey);
    if (!state) return undefined;
    return {
      runId,
      runtimeType: "sandbox",
      runtimeResourceId: state.runtimeResourceId,
      conversationId: state.activeRuns.get(runId) ?? "",
    };
  }

  heartbeatRun(runId: string): void {
    const scopeKey = this.findScopeKeyByRun(runId);
    if (!scopeKey) return;
    this.heartbeats.beat(scopeKey);
  }

  heartbeatRuntimeResource(resourceKey: string): void {
    this.heartbeats.beat(resourceKey);
  }

  cleanupRun(runId: string): void {
    const scopeKey = this.findScopeKeyByRun(runId);
    if (!scopeKey) return;

    this.scopeStates.get(scopeKey)?.activeRuns.delete(runId);
    const state = this.scopeStates.get(scopeKey);
    if (state && state.activeRuns.size === 0 && state.runtimeResourceId) {
      const idleTimeoutMs = this.configService.getIdleTimeoutSeconds() * 1000;
      this.idleWatchdog.start(scopeKey, idleTimeoutMs, () =>
        this.handleIdle(scopeKey)
      );
    }
  }

  shutdownRuntimeResource(
    resourceKey: string,
    callbacks: Pick<SandboxRuntimeResourceCallbacks, "cleanupWorkspace">
  ): void {
    const state = this.scopeStates.get(resourceKey);
    this.heartbeats.stop(resourceKey);
    this.idleWatchdog.cancel(resourceKey);
    if (state?.runtimeResourceId) {
      const engine = this.engines.get(state.engineType);
      engine?.stop(state.runtimeResourceId).catch(
        swallow(this.logger, `stop sandbox for runtime resource ${resourceKey}`)
      );
    }
    if (state) {
      this.workspaceRuntimeService
        .markStoppedByResourceKey(
          "sandbox",
          state.isolationScope,
          resourceKey
        )
        .catch(
          swallow(
            this.logger,
            `mark runtime resource stopped for key ${resourceKey}`
          )
        );
    }
    this.runtimeAccess.revokeWorkspace(resourceKey);
    callbacks.cleanupWorkspace(resourceKey);
    this.scopeStates.delete(resourceKey);
    this.pendingSandboxes.delete(resourceKey);
  }

  async recoverOrphan(runtimeResourceId: string): Promise<void> {
    for (const engine of this.engines.values()) {
      await engine.recoverOrphan(runtimeResourceId).catch(
        swallow(this.logger, `recover orphan via ${engine.type} engine`)
      );
    }
  }

  private attachReadyRuntimeResource(
    attachment: SandboxRuntimeResourceAttachment
  ): void {
    const { context, scopeState, handle } = attachment;
    handle.runtimeResourceId = scopeState.runtimeResourceId;
    void this.recordWorkspaceRuntime(
      context.placement,
      context.resourceKey,
      scopeState.runtimeResourceId
    );
  }

  private attachPendingRuntimeResource(
    attachment: SandboxRuntimeResourceAttachment,
    runtimePromise: Promise<SandboxRuntime>,
    callbacks: SandboxRuntimeResourceCallbacks
  ): void {
    const { context, handle, onRuntimeResourceIdReady } = attachment;
    void runtimePromise
      .then((runtime) => {
        if (callbacks.consumeCancelledStartingRun(context.runId)) {
          this.scopeStates
            .get(context.resourceKey)
            ?.activeRuns.delete(context.runId);
          callbacks.forceCancelled(context.runId);
          return;
        }
        void this.recordWorkspaceRuntime(
          context.placement,
          context.resourceKey,
          runtime.runtimeResourceId
        );
        handle.runtimeResourceId = runtime.runtimeResourceId;
        onRuntimeResourceIdReady?.(runtime.runtimeResourceId);
      })
      .catch((err) => {
        callbacks.publishWorkerError(
          context.runId,
          `sandbox create failed: ${String(err)}`
        );
        this.logger.warn(
          `pending sandbox failed ${safeLogJson({
            runId: context.runId,
            resourceKey: context.resourceKey,
            engineType: context.engineType,
            ...errorLogFields(err),
          })}`
        );
      });
  }

  private startRuntimeResourceForScope(
    attachment: SandboxRuntimeResourceAttachment,
    callbacks: SandboxRuntimeResourceCallbacks
  ): void {
    const { context, scopeState } = attachment;
    const engineInput = this.buildSandboxStartInput(
      context,
      scopeState.accessKey
    );
    const resumeRuntimeResourceId = scopeState.lastStoppedRuntimeResourceId;
    scopeState.lastStoppedRuntimeResourceId = undefined;

    const runtimePromise = this.createSandbox(
      context.engine,
      engineInput,
      resumeRuntimeResourceId
    );
    this.pendingSandboxes.set(context.resourceKey, runtimePromise);

    void runtimePromise
      .then((runtime) =>
        this.onRuntimeResourceStarted(attachment, runtime, callbacks)
      )
      .catch((err) =>
        this.onRuntimeResourceStartFailed(context, err, callbacks)
      );
  }

  private buildSandboxStartInput(
    context: SandboxWorkerExecutionContext,
    accessKey: string
  ): SandboxStartInput {
    const apiBase = resolveDockerApiBase();
    const sandboxPlacement: SandboxPlacement = {
      isolationScope: context.isolationScope,
      resourceKey: context.resourceKey,
      workspaceId: context.workspaceId,
      workspaceHostPath: context.placement.hostPath,
      workspaceMountPath: context.placement.sandbox.mountTarget,
    };

    return {
      placement: sandboxPlacement,
      image: DEFAULT_WORKER_IMAGE,
      apiBaseUrl: apiBase,
      accessKey,
      env: {
        AGEWORK_INTERNAL_TRANSPORT: "http",
        AGEWORK_INTERNAL_API_BASE: apiBase,
        AGEWORK_INTERNAL_RUNTIME_ACCESS_KEY: accessKey,
        AGEWORK_INTERNAL_WORKSPACE_ID: context.resourceKey,
        AGEWORK_INTERNAL_RUNTIME_TYPE: "sandbox",
        AGEWORK_INTERNAL_SANDBOX_ENGINE: context.engineType,
        AGEWORK_INTERNAL_ISOLATION_SCOPE: context.isolationScope,
        AGEWORK_INTERNAL_RUNTIME_RESOURCE_KEY: context.resourceKey,
        AGEWORK_INTERNAL_RUNTIME_RESOURCE_NAME: `agework-worker-${safePathPart(
          context.resourceKey
        )}`,
        AGEWORK_INTERNAL_LOG_DIR: CONTAINER_RUNTIME_LOG_DIR,
        AGEWORK_INTERNAL_WORKER_LOG_FILE: `${CONTAINER_RUNTIME_LOG_DIR}/${safePathPart(
          context.resourceKey
        )}.runtime.worker.log`,
      },
      metadata: {
        "agework.io/runtime-resource-key": context.resourceKey,
        "agework.io/isolation-scope": context.isolationScope,
      },
      runtimeLogHostPath: this.configService.getRuntimeLogDir(),
      runtimeLogMountPath: CONTAINER_RUNTIME_LOG_DIR,
      isExpectedRuntimeResource: (runtimeResourceId: string) =>
        this.workspaceRuntimeService.isRuntimeResourceBoundToWorkspace(
          "sandbox",
          context.workspaceId,
          runtimeResourceId
        ),
    };
  }

  private onRuntimeResourceStarted(
    attachment: SandboxRuntimeResourceAttachment,
    runtime: SandboxRuntime,
    callbacks: SandboxRuntimeResourceCallbacks
  ): void {
    const { context, handle, onRuntimeResourceIdReady } = attachment;
    this.pendingSandboxes.delete(context.resourceKey);
    const state = this.scopeStates.get(context.resourceKey);
    if (!state) return;

    state.runtimeResourceId = runtime.runtimeResourceId;
    this.logger.log(
      `sandbox created ${safeLogJson({
        resourceKey: context.resourceKey,
        engine: runtime.engineType,
        resourceId: runtime.runtimeResourceId.slice(0, 12),
        activeRuns: state.activeRuns.size,
      })}`
    );

    void this.recordWorkspaceRuntime(
      context.placement,
      context.resourceKey,
      runtime.runtimeResourceId
    );

    this.forceCancelledStartingRuns(state, callbacks);

    if (state.activeRuns.has(context.runId)) {
      handle.runtimeResourceId = runtime.runtimeResourceId;
      onRuntimeResourceIdReady?.(runtime.runtimeResourceId);
    }

    this.startRuntimeHeartbeat(
      context.resourceKey,
      context.runId,
      runtime,
      callbacks
    );
  }

  private onRuntimeResourceStartFailed(
    context: SandboxWorkerExecutionContext,
    err: unknown,
    callbacks: SandboxRuntimeResourceCallbacks
  ): void {
    this.pendingSandboxes.delete(context.resourceKey);
    this.logger.error(
      `sandbox create failed ${safeLogJson({
        runId: context.runId,
        resourceKey: context.resourceKey,
        engineType: context.engineType,
        ...errorLogFields(err),
      })}`
    );
    callbacks.publishWorkerError(
      context.runId,
      `sandbox create failed: ${String(err)}`
    );

    const state = this.scopeStates.get(context.resourceKey);
    if (state) {
      this.forceCancelledStartingRuns(state, callbacks);
    }

    this.scopeStates.delete(context.resourceKey);
    callbacks.cleanupWorkspace(context.resourceKey);
    this.runtimeAccess.revokeWorkspace(context.resourceKey);
  }

  private forceCancelledStartingRuns(
    state: SandboxScopeState,
    callbacks: SandboxRuntimeResourceCallbacks
  ): void {
    for (const runId of state.activeRuns.keys()) {
      if (callbacks.consumeCancelledStartingRun(runId)) {
        state.activeRuns.delete(runId);
        callbacks.forceCancelled(runId);
      }
    }
  }

  private startRuntimeHeartbeat(
    resourceKey: string,
    fallbackRunId: string,
    runtime: SandboxRuntime,
    callbacks: SandboxRuntimeResourceCallbacks
  ): void {
    this.heartbeats.start(resourceKey, () => {
      const state = this.scopeStates.get(resourceKey);
      const targetRunIds = state?.activeRuns.size
        ? [...state.activeRuns.keys()]
        : [fallbackRunId];
      this.logger.error(
        `sandbox heartbeat timeout ${safeLogJson({
          resourceKey,
          engineType: runtime.engineType,
          activeRuns: targetRunIds.length,
        })}`
      );
      // 心跳超时只代表失联，不代表容器/资源已损坏：不主动 stop/删除容器，
      // 只是放弃对它的引用，让下次该 scope 的请求重新创建。
      if (state) {
        this.releaseScopeRuntime(resourceKey, state);
      }
      for (const runId of targetRunIds) {
        callbacks.publishWorkerError(runId, "worker heartbeat timeout");
      }
    });
  }

  private async createSandbox(
    engine: SandboxEngine,
    input: SandboxStartInput,
    resumeRuntimeResourceId?: string
  ): Promise<SandboxRuntime> {
    if (resumeRuntimeResourceId && engine.resume) {
      try {
        const runtime = await engine.resume(resumeRuntimeResourceId, input);
        await engine.startWorker(runtime, input);
        return runtime;
      } catch (err) {
        this.logger.warn(
          `resume failed, falling back to getOrCreate ${safeLogJson({
            resumeRuntimeResourceId,
            ...errorLogFields(err),
          })}`
        );
      }
    }

    const runtime = await engine.getOrCreate(input);
    await engine.startWorker(runtime, input);
    return runtime;
  }

  private handleIdle(resourceKey: string): void {
    const state = this.scopeStates.get(resourceKey);
    if (!state || !state.runtimeResourceId) return;
    if (state.activeRuns.size > 0) return;

    this.logger.log(
      `sandbox idle timeout ${safeLogJson({
        resourceKey,
        resourceId: state.runtimeResourceId.slice(0, 12),
        engineType: state.engineType,
      })}`
    );

    const engine = this.engines.get(state.engineType);
    engine?.stop(state.runtimeResourceId).catch(
      swallow(this.logger, `stop idle sandbox for runtime resource ${resourceKey}`)
    );

    this.releaseScopeRuntime(resourceKey, state);
  }

  /**
   * 放弃对某个 runtime resource 当前容器/沙箱的引用：停止心跳与空闲计时、清空
   * activeRuns 与 runtimeResourceId（转存为 lastStoppedRuntimeResourceId 供下次 resume），
   * 并将 RuntimeResource 标记为 stopped。access key 保留，供 resume 复用。
   * 不负责真正停止/删除容器——是否需要 engine.stop() 由调用方决定。
   */
  private releaseScopeRuntime(
    resourceKey: string,
    state: SandboxScopeState
  ): void {
    this.heartbeats.stop(resourceKey);
    this.idleWatchdog.cancel(resourceKey);
    state.activeRuns.clear();
    state.lastStoppedRuntimeResourceId = state.runtimeResourceId;
    state.runtimeResourceId = "";

    this.workspaceRuntimeService
      .markStoppedByResourceKey(
        "sandbox",
        state.isolationScope,
        resourceKey
      )
      .catch(
        swallow(
          this.logger,
          `mark runtime resource stopped for key ${resourceKey}`
        )
      );
  }

  private recordWorkspaceRuntime(
    placement: SandboxRuntimePlacement,
    resourceKey: string,
    runtimeResourceId: string
  ): Promise<void> {
    return this.workspaceRuntimeService
      .upsertRunning(placement, runtimeResourceId)
      .then(({ resource }) => {
        this.runtimeAccess.issueRuntimeResourceKey(
          resource.id,
          resourceKey,
          resource.runtimeType
        );
      })
      .catch(
        swallow(
          this.logger,
          `upsert workspace runtime for resource key ${resourceKey}`
        )
      );
  }

  private resolveEngine(engineType: SandboxEngineType): SandboxEngine {
    const engine = this.engines.get(engineType);
    if (!engine) {
      throw new Error(`Unknown sandbox engine: ${engineType}`);
    }
    return engine;
  }
}
