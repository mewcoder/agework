import { Inject, Injectable, Logger } from "@nestjs/common";
import type {
  IsolationScope,
  RuntimeTarget,
  SandboxRuntimePlacement,
  WorkerExecutionHandle,
  WorkerExecutionStartInput,
} from "@agework/shared/protocol";
import { isSandboxPlacement } from "../../resources/runtime-resource";
import { ConfigService } from "../../../config/config.service";
import { CONTAINER_RUNTIME_LOG_DIR, DEFAULT_WORKER_IMAGE } from "../../../config/defaults";
import { WorkerAccessService } from "../../../worker-host/access.service";
import { WorkspaceRuntimeInstanceRepository } from "../../resources/workspace-runtime-instance.repository";
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
  runtimeInstanceId: string;
  /** 上次 idle/心跳超时释放时的容器 ID，供下次 start() resume；resume 成功或全新创建后清空。 */
  lastStoppedRuntimeInstanceId?: string;
  accessKey: string;
  activeRuns: Map<string, string>;
  isolationScope: IsolationScope;
  engineType: SandboxEngineType;
};

export type SandboxWorkerExecutionContext = {
  runConfig: WorkerExecutionStartInput["runConfig"];
  runtimeTarget: RuntimeTarget;
  placement: SandboxRuntimePlacement;
  runId: string;
  workspaceId: string;
  scopeKey: string;
  isolationScope: IsolationScope;
  engineType: SandboxEngineType;
  engine: SandboxEngine;
};

export type SandboxRuntimeInstanceAttachment = {
  context: SandboxWorkerExecutionContext;
  scopeState: SandboxScopeState;
  handle: WorkerExecutionHandle;
  onRuntimeInstanceIdReady?: (runtimeInstanceId: string) => void;
};

export type SandboxRuntimeInstanceCallbacks = {
  consumeCancelledStartingRun(runId: string): boolean;
  forceCancelled(runId: string): void;
  publishWorkerError(runId: string, error: string): void;
  cleanupWorkspace(scopeKey: string): void;
};

@Injectable()
export class SandboxRuntimeInstanceService {
  private readonly logger = new Logger(SandboxRuntimeInstanceService.name);

  private readonly scopeStates = new Map<string, SandboxScopeState>();
  private readonly pendingSandboxes = new Map<string, Promise<SandboxRuntime>>();
  private readonly heartbeats = new HeartbeatWatchdog();
  private readonly idleWatchdog = new IdleWatchdog();
  private readonly engines: Map<SandboxEngineType, SandboxEngine>;

  constructor(
    private readonly configService: ConfigService,
    private readonly workspaceRuntimeService: WorkspaceRuntimeInstanceRepository,
    private readonly runtimeAccess: WorkerAccessService,
    @Inject(SANDBOX_ENGINES) engines: SandboxEngine[]
  ) {
    this.engines = new Map(engines.map((e) => [e.type, e]));
  }

  resolveWorkerExecutionContext(
    input: WorkerExecutionStartInput
  ): SandboxWorkerExecutionContext {
    const placement = input.runtimeTarget;
    if (!isSandboxPlacement(placement)) {
      throw new Error(
        `SandboxRuntimeInstanceService requires sandbox placement, got runtimeType=${placement.runtimeType}`
      );
    }
    const engineType =
      placement.sandbox.sandboxEngineType ?? this.configService.getSandboxEngine();
    return {
      runConfig: input.runConfig,
      runtimeTarget: input.runtimeTarget,
      placement,
      runId: input.runConfig.runId,
      workspaceId: input.runConfig.workspaceId,
      scopeKey: input.runtimeTarget.scopeKey,
      isolationScope: placement.sandbox.isolationScope,
      engineType,
      engine: this.resolveEngine(engineType),
    };
  }

  createRunHandle(context: SandboxWorkerExecutionContext): WorkerExecutionHandle {
    return {
      runId: context.runId,
      runtimeType: context.runtimeTarget.runtimeType,
      runtimeInstanceId: "",
      conversationId: context.runConfig.conversationId,
    };
  }

  ensureScopeState(
    context: SandboxWorkerExecutionContext
  ): SandboxScopeState {
    let scopeState = this.scopeStates.get(context.scopeKey);
    if (!scopeState) {
      const accessKey = this.runtimeAccess.issueWorkspaceKey(
        context.scopeKey
      );
      scopeState = {
        runtimeInstanceId: "",
        accessKey,
        activeRuns: new Map(),
        isolationScope: context.isolationScope,
        engineType: context.engineType,
      };
      this.scopeStates.set(context.scopeKey, scopeState);
      this.idleWatchdog.cancel(context.scopeKey);
      return scopeState;
    }

    if (
      !scopeState.runtimeInstanceId &&
      !this.pendingSandboxes.has(context.scopeKey) &&
      !scopeState.lastStoppedRuntimeInstanceId
    ) {
      scopeState.accessKey = this.runtimeAccess.issueWorkspaceKey(
        context.scopeKey
      );
      scopeState.engineType = context.engineType;
    }

    this.idleWatchdog.cancel(context.scopeKey);
    return scopeState;
  }

  attachOrStartRuntimeInstance(
    attachment: SandboxRuntimeInstanceAttachment,
    callbacks: SandboxRuntimeInstanceCallbacks
  ): void {
    const { context, scopeState } = attachment;
    if (scopeState.runtimeInstanceId) {
      this.attachReadyRuntimeInstance(attachment);
      return;
    }

    const existingPending = this.pendingSandboxes.get(context.scopeKey);
    if (existingPending) {
      this.attachPendingRuntimeInstance(attachment, existingPending, callbacks);
      return;
    }

    this.startRuntimeInstanceForScope(attachment, callbacks);
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
      runtimeInstanceId: state.runtimeInstanceId,
      conversationId: state.activeRuns.get(runId) ?? "",
    };
  }

  heartbeatRun(runId: string): void {
    const scopeKey = this.findScopeKeyByRun(runId);
    if (!scopeKey) return;
    this.heartbeats.beat(scopeKey);
  }

  heartbeatRuntimeInstance(scopeKey: string): void {
    this.heartbeats.beat(scopeKey);
  }

  cleanupRun(runId: string): void {
    const scopeKey = this.findScopeKeyByRun(runId);
    if (!scopeKey) return;

    this.scopeStates.get(scopeKey)?.activeRuns.delete(runId);
    const state = this.scopeStates.get(scopeKey);
    if (state && state.activeRuns.size === 0 && state.runtimeInstanceId) {
      const idleTimeoutMs = this.configService.getIdleTimeoutSeconds() * 1000;
      this.idleWatchdog.start(scopeKey, idleTimeoutMs, () =>
        this.handleIdle(scopeKey)
      );
    }
  }

  shutdownRuntimeInstance(
    scopeKey: string,
    callbacks: Pick<SandboxRuntimeInstanceCallbacks, "cleanupWorkspace">
  ): void {
    const state = this.scopeStates.get(scopeKey);
    this.heartbeats.stop(scopeKey);
    this.idleWatchdog.cancel(scopeKey);
    if (state?.runtimeInstanceId) {
      const engine = this.engines.get(state.engineType);
      engine?.stop(state.runtimeInstanceId).catch(
        swallow(this.logger, `stop sandbox for runtime resource ${scopeKey}`)
      );
    }
    if (state) {
      this.workspaceRuntimeService
        .markStoppedByScopeKey(
          "sandbox",
          state.isolationScope,
          scopeKey
        )
        .catch(
          swallow(
            this.logger,
            `mark runtime resource stopped for key ${scopeKey}`
          )
        );
    }
    this.runtimeAccess.revokeWorkspace(scopeKey);
    callbacks.cleanupWorkspace(scopeKey);
    this.scopeStates.delete(scopeKey);
    this.pendingSandboxes.delete(scopeKey);
  }

  async recoverOrphan(runtimeInstanceId: string): Promise<void> {
    for (const engine of this.engines.values()) {
      await engine.recoverOrphan(runtimeInstanceId).catch(
        swallow(this.logger, `recover orphan via ${engine.type} engine`)
      );
    }
  }

  private attachReadyRuntimeInstance(
    attachment: SandboxRuntimeInstanceAttachment
  ): void {
    const { context, scopeState, handle } = attachment;
    handle.runtimeInstanceId = scopeState.runtimeInstanceId;
    void this.recordWorkspaceRuntime(
      context.placement,
      context.scopeKey,
      scopeState.runtimeInstanceId
    );
  }

  private attachPendingRuntimeInstance(
    attachment: SandboxRuntimeInstanceAttachment,
    runtimePromise: Promise<SandboxRuntime>,
    callbacks: SandboxRuntimeInstanceCallbacks
  ): void {
    const { context, handle, onRuntimeInstanceIdReady } = attachment;
    void runtimePromise
      .then((runtime) => {
        if (callbacks.consumeCancelledStartingRun(context.runId)) {
          this.scopeStates
            .get(context.scopeKey)
            ?.activeRuns.delete(context.runId);
          callbacks.forceCancelled(context.runId);
          return;
        }
        void this.recordWorkspaceRuntime(
          context.placement,
          context.scopeKey,
          runtime.runtimeInstanceId
        );
        handle.runtimeInstanceId = runtime.runtimeInstanceId;
        onRuntimeInstanceIdReady?.(runtime.runtimeInstanceId);
      })
      .catch((err) => {
        callbacks.publishWorkerError(
          context.runId,
          `sandbox create failed: ${String(err)}`
        );
        this.logger.warn(
          `pending sandbox failed ${safeLogJson({
            runId: context.runId,
            scopeKey: context.scopeKey,
            engineType: context.engineType,
            ...errorLogFields(err),
          })}`
        );
      });
  }

  private startRuntimeInstanceForScope(
    attachment: SandboxRuntimeInstanceAttachment,
    callbacks: SandboxRuntimeInstanceCallbacks
  ): void {
    const { context, scopeState } = attachment;
    const engineInput = this.buildSandboxStartInput(
      context,
      scopeState.accessKey
    );
    const resumeRuntimeInstanceId = scopeState.lastStoppedRuntimeInstanceId;
    scopeState.lastStoppedRuntimeInstanceId = undefined;

    const runtimePromise = this.createSandbox(
      context,
      context.engine,
      engineInput,
      resumeRuntimeInstanceId
    );
    this.pendingSandboxes.set(context.scopeKey, runtimePromise);

    void runtimePromise
      .then((runtime) =>
        this.onRuntimeInstanceStarted(attachment, runtime, callbacks)
      )
      .catch((err) =>
        this.onRuntimeInstanceStartFailed(context, err, callbacks)
      );
  }

  private buildSandboxStartInput(
    context: SandboxWorkerExecutionContext,
    accessKey: string
  ): SandboxStartInput {
    const apiBase = resolveDockerApiBase();
    const sandboxPlacement: SandboxPlacement = {
      isolationScope: context.isolationScope,
      scopeKey: context.scopeKey,
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
        AGEWORK_WORKER_CHANNEL: "http",
        AGEWORK_WORKER_API_BASE: apiBase,
        AGEWORK_WORKER_RUNTIME_ACCESS_KEY: accessKey,
        AGEWORK_WORKER_WORKSPACE_ID: context.scopeKey,
        AGEWORK_WORKER_RUNTIME_TYPE: "sandbox",
        AGEWORK_WORKER_SANDBOX_ENGINE: context.engineType,
        AGEWORK_WORKER_ISOLATION_SCOPE: context.isolationScope,
        AGEWORK_WORKER_RUNTIME_SCOPE_KEY: context.scopeKey,
        AGEWORK_WORKER_RUNTIME_RESOURCE_NAME: `agework-worker-${safePathPart(
          context.scopeKey
        )}`,
        AGEWORK_WORKER_LOG_DIR: CONTAINER_RUNTIME_LOG_DIR,
        AGEWORK_WORKER_LOG_FILE: `${CONTAINER_RUNTIME_LOG_DIR}/${safePathPart(
          context.scopeKey
        )}.runtime.worker.log`,
      },
      metadata: {
        "agework.io/runtime-scope-key": context.scopeKey,
        "agework.io/isolation-scope": context.isolationScope,
      },
      runtimeLogHostPath: this.configService.getRuntimeLogDir(),
      runtimeLogMountPath: CONTAINER_RUNTIME_LOG_DIR,
      isExpectedRuntimeInstance: (runtimeInstanceId: string) =>
        this.workspaceRuntimeService.isRuntimeInstanceBoundToWorkspace(
          "sandbox",
          context.workspaceId,
          runtimeInstanceId
        ),
    };
  }

  private onRuntimeInstanceStarted(
    attachment: SandboxRuntimeInstanceAttachment,
    runtime: SandboxRuntime,
    callbacks: SandboxRuntimeInstanceCallbacks
  ): void {
    const { context, handle, onRuntimeInstanceIdReady } = attachment;
    this.pendingSandboxes.delete(context.scopeKey);
    const state = this.scopeStates.get(context.scopeKey);
    if (!state) return;

    state.runtimeInstanceId = runtime.runtimeInstanceId;
    this.logger.log(
      `sandbox created ${safeLogJson({
        scopeKey: context.scopeKey,
        engine: runtime.engineType,
        resourceId: runtime.runtimeInstanceId.slice(0, 12),
        activeRuns: state.activeRuns.size,
      })}`
    );

    void this.recordWorkspaceRuntime(
      context.placement,
      context.scopeKey,
      runtime.runtimeInstanceId
    );

    this.forceCancelledStartingRuns(state, callbacks);

    if (state.activeRuns.has(context.runId)) {
      handle.runtimeInstanceId = runtime.runtimeInstanceId;
      onRuntimeInstanceIdReady?.(runtime.runtimeInstanceId);
    }

    this.startRuntimeHeartbeat(
      context.scopeKey,
      context.runId,
      runtime,
      callbacks
    );
  }

  private onRuntimeInstanceStartFailed(
    context: SandboxWorkerExecutionContext,
    err: unknown,
    callbacks: SandboxRuntimeInstanceCallbacks
  ): void {
    this.pendingSandboxes.delete(context.scopeKey);
    this.logger.error(
      `sandbox create failed ${safeLogJson({
        runId: context.runId,
        scopeKey: context.scopeKey,
        engineType: context.engineType,
        ...errorLogFields(err),
      })}`
    );
    callbacks.publishWorkerError(
      context.runId,
      `sandbox create failed: ${String(err)}`
    );

    const state = this.scopeStates.get(context.scopeKey);
    if (state) {
      this.forceCancelledStartingRuns(state, callbacks);
    }

    this.scopeStates.delete(context.scopeKey);
    callbacks.cleanupWorkspace(context.scopeKey);
    this.runtimeAccess.revokeWorkspace(context.scopeKey);
  }

  private forceCancelledStartingRuns(
    state: SandboxScopeState,
    callbacks: SandboxRuntimeInstanceCallbacks
  ): void {
    for (const runId of state.activeRuns.keys()) {
      if (callbacks.consumeCancelledStartingRun(runId)) {
        state.activeRuns.delete(runId);
        callbacks.forceCancelled(runId);
      }
    }
  }

  private startRuntimeHeartbeat(
    scopeKey: string,
    fallbackRunId: string,
    runtime: SandboxRuntime,
    callbacks: SandboxRuntimeInstanceCallbacks
  ): void {
    this.heartbeats.start(scopeKey, () => {
      const state = this.scopeStates.get(scopeKey);
      const targetRunIds = state?.activeRuns.size
        ? [...state.activeRuns.keys()]
        : [fallbackRunId];
      this.logger.error(
        `sandbox heartbeat timeout ${safeLogJson({
          scopeKey,
          engineType: runtime.engineType,
          activeRuns: targetRunIds.length,
        })}`
      );
      // 心跳超时只代表失联，不代表容器/资源已损坏：不主动 stop/删除容器，
      // 只是放弃对它的引用，让下次该 scope 的请求重新创建。
      if (state) {
        this.releaseScopeRuntime(scopeKey, state);
      }
      for (const runId of targetRunIds) {
        callbacks.publishWorkerError(runId, "worker heartbeat timeout");
      }
    });
  }

  private async createSandbox(
    context: SandboxWorkerExecutionContext,
    engine: SandboxEngine,
    input: SandboxStartInput,
    resumeRuntimeInstanceId?: string
  ): Promise<SandboxRuntime> {
    if (resumeRuntimeInstanceId && engine.resume) {
      try {
        const runtime = await engine.resume(resumeRuntimeInstanceId, input);
        this.registerRuntimeInstanceAccess(context, runtime.runtimeInstanceId);
        await engine.startWorker(runtime, input);
        return runtime;
      } catch (err) {
        this.logger.warn(
          `resume failed, falling back to getOrCreate ${safeLogJson({
            resumeRuntimeInstanceId,
            ...errorLogFields(err),
          })}`
        );
      }
    }

    const runtime = await engine.getOrCreate(input);
    this.registerRuntimeInstanceAccess(context, runtime.runtimeInstanceId);
    await engine.startWorker(runtime, input);
    return runtime;
  }

  private handleIdle(scopeKey: string): void {
    const state = this.scopeStates.get(scopeKey);
    if (!state || !state.runtimeInstanceId) return;
    if (state.activeRuns.size > 0) return;

    this.logger.log(
      `sandbox idle timeout ${safeLogJson({
        scopeKey,
        resourceId: state.runtimeInstanceId.slice(0, 12),
        engineType: state.engineType,
      })}`
    );

    const engine = this.engines.get(state.engineType);
    engine?.stop(state.runtimeInstanceId).catch(
      swallow(this.logger, `stop idle sandbox for runtime resource ${scopeKey}`)
    );

    this.releaseScopeRuntime(scopeKey, state);
  }

  /**
   * 放弃对某个 runtime resource 当前容器/沙箱的引用：停止心跳与空闲计时、清空
   * activeRuns 与 runtimeInstanceId（转存为 lastStoppedRuntimeInstanceId 供下次 resume），
   * 并将 RuntimeTarget 标记为 stopped。access key 保留，供 resume 复用。
   * 不负责真正停止/删除容器——是否需要 engine.stop() 由调用方决定。
   */
  private releaseScopeRuntime(
    scopeKey: string,
    state: SandboxScopeState
  ): void {
    this.heartbeats.stop(scopeKey);
    this.idleWatchdog.cancel(scopeKey);
    state.activeRuns.clear();
    state.lastStoppedRuntimeInstanceId = state.runtimeInstanceId;
    state.runtimeInstanceId = "";

    this.workspaceRuntimeService
      .markStoppedByScopeKey(
        "sandbox",
        state.isolationScope,
        scopeKey
      )
      .catch(
        swallow(
          this.logger,
          `mark runtime resource stopped for key ${scopeKey}`
        )
      );
  }

  private recordWorkspaceRuntime(
    placement: SandboxRuntimePlacement,
    scopeKey: string,
    runtimeInstanceId: string
  ): Promise<void> {
    return this.workspaceRuntimeService
      .upsertRunning(placement, scopeKey, runtimeInstanceId)
      .then(() => undefined)
      .catch(
        swallow(
          this.logger,
          `upsert workspace runtime for resource key ${scopeKey}`
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

  private registerRuntimeInstanceAccess(
    context: SandboxWorkerExecutionContext,
    runtimeInstanceId: string
  ): void {
    this.runtimeAccess.issueRuntimeInstanceKey(
      runtimeInstanceId,
      context.scopeKey,
      context.runtimeTarget.runtimeType
    );
  }
}
