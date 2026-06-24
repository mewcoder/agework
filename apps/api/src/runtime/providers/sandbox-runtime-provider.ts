import { Inject, Injectable, Logger } from "@nestjs/common";
import { generateId } from "@agework/shared";
import type {
  RuntimeProvider,
  RuntimeHandle,
  RunConfig,
  RuntimePlacement,
  IsolationScope,
  ControlPayload,
} from "@agework/shared/protocol";
import { RunEnvelopeProcessor } from "../../runs/execution/run-envelope.processor";
import { RuntimeConfigStore } from "../internal/runtime-config-store";
import { RuntimeInternalAccessService } from "../internal/runtime-internal-access.service";
import { RuntimeControlQueue } from "../internal/runtime-control-queue";
import { ConfigService } from "../../config/config.service";
import { CONTAINER_RUNTIME_LOG_DIR, DEFAULT_WORKER_IMAGE } from "../../config/defaults";
import { WorkspaceRuntimeRepository } from "../core/runtime-resources/workspace-runtime.repository";
import { swallow } from "../../common/swallow";
import {
  HeartbeatWatchdog,
  IdleWatchdog,
  nextControlEnvelope,
  publishWorkerErrorStatus,
  resolveDockerApiBase,
} from "./runtime-provider-utils";
import type { SandboxEngine, SandboxEngineType, SandboxStartInput, SandboxPlacement, SandboxRuntime } from "./sandbox-engine";
import { SANDBOX_ENGINES } from "./sandbox-engine";
import { errorLogFields, safeLogJson } from "../../common/logging";
import { safePathPart } from "../../common/safe-path";

type SandboxScopeState = {
  runtimeResourceId: string;
  /** 上次 idle/心跳超时释放时的容器 ID，供下次 start() resume；resume 成功或全新创建后清空。 */
  lastStoppedRuntimeResourceId?: string;
  accessKey: string;
  activeRuns: Map<string, string>; // runId → conversationId
  isolationScope: IsolationScope;
  engineType: SandboxEngineType;
};

@Injectable()
export class SandboxRuntimeProvider implements RuntimeProvider {
  readonly type = "sandbox" as const;
  private readonly logger = new Logger(SandboxRuntimeProvider.name);

  private readonly scopeStates = new Map<string, SandboxScopeState>();
  private readonly pendingSandboxes = new Map<string, Promise<SandboxRuntime>>();
  private readonly cancelledStartingRuns = new Set<string>();
  private readonly heartbeats = new HeartbeatWatchdog();
  private readonly idleWatchdog = new IdleWatchdog();
  private readonly controlSeqs = new Map<string, number>();

  private readonly engines: Map<SandboxEngineType, SandboxEngine>;

  constructor(
    private readonly runEventProcessor: RunEnvelopeProcessor,
    private readonly runConfigStore: RuntimeConfigStore,
    private readonly runtimeAccess: RuntimeInternalAccessService,
    private readonly controlQueue: RuntimeControlQueue,
    private readonly configService: ConfigService,
    private readonly workspaceRuntimeService: WorkspaceRuntimeRepository,
    @Inject(SANDBOX_ENGINES) engines: SandboxEngine[]
  ) {
    this.engines = new Map(engines.map((e) => [e.type, e]));
  }

  start(
    runConfig: RunConfig,
    placement: RuntimePlacement & { sandboxEngineType?: SandboxEngineType },
    onRuntimeResourceIdReady?: (runtimeResourceId: string) => void
  ): RuntimeHandle {
    const { runId, workspaceId } = runConfig;
    const { isolationScope, hostPath, mountTarget } = placement;
    const resourceKey = this.resourceKeyForPlacement(placement);
    const engineType = placement.sandboxEngineType ?? this.configService.getSandboxEngine();
    const engine = this.resolveEngine(engineType);
    const apiBase = resolveDockerApiBase();
    const image = DEFAULT_WORKER_IMAGE;
    this.logger.log(
      `sandbox run starting ${safeLogJson({
        runId,
        conversationId: runConfig.conversationId,
        workspaceId,
        resourceKey,
        isolationScope,
        engineType,
      })}`
    );

    this.runConfigStore.register(runId, runConfig);

    const handle: RuntimeHandle = {
      runId,
      runtimeType: "sandbox",
      runtimeResourceId: "",
      conversationId: runConfig.conversationId,
    };

    let scopeState = this.scopeStates.get(resourceKey);
    if (!scopeState) {
      const accessKey = this.runtimeAccess.issueWorkspaceKey(resourceKey);
      scopeState = {
        runtimeResourceId: "",
        accessKey,
        activeRuns: new Map(),
        isolationScope,
        engineType,
      };
      this.scopeStates.set(resourceKey, scopeState);
    } else if (
      !scopeState.runtimeResourceId &&
      !this.pendingSandboxes.has(resourceKey) &&
      !scopeState.lastStoppedRuntimeResourceId
    ) {
      scopeState.accessKey = this.runtimeAccess.issueWorkspaceKey(resourceKey);
      scopeState.engineType = engineType;
    }

    this.runtimeAccess.registerRun(runId, scopeState.accessKey);
    scopeState.activeRuns.set(runId, runConfig.conversationId);
    this.idleWatchdog.cancel(resourceKey);

    if (!this.controlSeqs.has(resourceKey)) {
      this.controlSeqs.set(resourceKey, 0);
    }

    this.pushScopeControl(resourceKey, runId, {
      type: "user_message",
      commandId: generateId(),
      runId,
      input: runConfig.input,
    });

    const existingPending = this.pendingSandboxes.get(resourceKey);
    if (scopeState.runtimeResourceId) {
      handle.runtimeResourceId = scopeState.runtimeResourceId;
      void this.recordWorkspaceRuntime(
        placement,
        resourceKey,
        scopeState.runtimeResourceId
      );
    } else if (existingPending) {
      void existingPending
        .then((runtime) => {
          if (this.cancelledStartingRuns.delete(runId)) {
            this.scopeStates.get(resourceKey)?.activeRuns.delete(runId);
            this.forceCancelled(runId);
            return;
          }
          void this.recordWorkspaceRuntime(
            placement,
            resourceKey,
            runtime.runtimeResourceId
          );
          handle.runtimeResourceId = runtime.runtimeResourceId;
          onRuntimeResourceIdReady?.(runtime.runtimeResourceId);
        })
        .catch((err) => {
          publishWorkerErrorStatus(
            this.runEventProcessor,
            runId,
            `sandbox create failed: ${String(err)}`
          );
          this.logger.warn(
            `pending sandbox failed ${safeLogJson({
              runId,
              resourceKey,
              engineType,
              ...errorLogFields(err),
            })}`
          );
        });
    } else {
      const sandboxPlacement: SandboxPlacement = {
        isolationScope,
        resourceKey,
        workspaceId,
        workspaceHostPath: hostPath,
        workspaceMountPath: mountTarget,
      };
      const engineInput: SandboxStartInput = {
        placement: sandboxPlacement,
        image,
        apiBaseUrl: apiBase,
        accessKey: scopeState.accessKey,
        env: {
          AGEWORK_INTERNAL_TRANSPORT: "http",
          AGEWORK_INTERNAL_API_BASE: apiBase,
          AGEWORK_INTERNAL_RUNTIME_ACCESS_KEY: scopeState.accessKey,
          AGEWORK_INTERNAL_WORKSPACE_ID: resourceKey,
          AGEWORK_INTERNAL_RUNTIME_TYPE: "sandbox",
          AGEWORK_INTERNAL_SANDBOX_ENGINE: engineType,
          AGEWORK_INTERNAL_ISOLATION_SCOPE: isolationScope,
          AGEWORK_INTERNAL_RUNTIME_RESOURCE_KEY: resourceKey,
          AGEWORK_INTERNAL_RUNTIME_RESOURCE_NAME: `agework-worker-${safePathPart(resourceKey)}`,
          AGEWORK_INTERNAL_LOG_DIR: CONTAINER_RUNTIME_LOG_DIR,
          AGEWORK_INTERNAL_WORKER_LOG_FILE: `${CONTAINER_RUNTIME_LOG_DIR}/${safePathPart(resourceKey)}.runtime.worker.log`,
        },
        metadata: {
          "agework.io/runtime-resource-key": resourceKey,
          "agework.io/isolation-scope": isolationScope,
        },
        runtimeLogHostPath: this.configService.getRuntimeLogDir(),
        runtimeLogMountPath: CONTAINER_RUNTIME_LOG_DIR,
        isExpectedRuntimeResource: (runtimeResourceId: string) =>
          this.workspaceRuntimeService.isRuntimeResourceBoundToWorkspace(
            "sandbox",
            workspaceId,
            runtimeResourceId
          ),
      };

      const resumeRuntimeResourceId = scopeState.lastStoppedRuntimeResourceId;
      scopeState.lastStoppedRuntimeResourceId = undefined;

      const runtimePromise = this.createSandbox(
        engine,
        engineInput,
        resumeRuntimeResourceId
      );
      this.pendingSandboxes.set(resourceKey, runtimePromise);

      void runtimePromise
        .then((runtime) => {
          this.pendingSandboxes.delete(resourceKey);
          const state = this.scopeStates.get(resourceKey);
          if (!state) return;

          state.runtimeResourceId = runtime.runtimeResourceId;
          this.logger.log(
            `sandbox created ${safeLogJson({
              resourceKey,
              engine: runtime.engineType,
              resourceId: runtime.runtimeResourceId.slice(0, 12),
              activeRuns: state.activeRuns.size,
            })}`
          );

          void this.recordWorkspaceRuntime(
            placement,
            resourceKey,
            runtime.runtimeResourceId
          );

          for (const cancelledRunId of this.cancelledStartingRuns) {
            if (state.activeRuns.has(cancelledRunId)) {
              state.activeRuns.delete(cancelledRunId);
              this.forceCancelled(cancelledRunId);
              this.cancelledStartingRuns.delete(cancelledRunId);
            }
          }

          if (state.activeRuns.has(runId)) {
            handle.runtimeResourceId = runtime.runtimeResourceId;
            onRuntimeResourceIdReady?.(runtime.runtimeResourceId);
          }

          this.heartbeats.start(resourceKey, () => {
            const state = this.scopeStates.get(resourceKey);
            const targetRunIds = state?.activeRuns.size
              ? [...state.activeRuns.keys()]
              : [runId];
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
            for (const rid of targetRunIds) {
              publishWorkerErrorStatus(
                this.runEventProcessor,
                rid,
                "worker heartbeat timeout"
              );
            }
          });
        })
        .catch((err) => {
          this.pendingSandboxes.delete(resourceKey);
          this.logger.error(
            `sandbox create failed ${safeLogJson({
              runId,
              resourceKey,
              engineType,
              ...errorLogFields(err),
            })}`
          );
          publishWorkerErrorStatus(
            this.runEventProcessor,
            runId,
            `sandbox create failed: ${String(err)}`
          );

          const state = this.scopeStates.get(resourceKey);
          if (state) {
            for (const cancelledRunId of this.cancelledStartingRuns) {
              if (state.activeRuns.has(cancelledRunId)) {
                state.activeRuns.delete(cancelledRunId);
                this.forceCancelled(cancelledRunId);
                this.cancelledStartingRuns.delete(cancelledRunId);
              }
            }
          }

          this.scopeStates.delete(resourceKey);
          this.controlSeqs.delete(resourceKey);
          this.controlQueue.cleanupWorkspace(resourceKey);
          this.runtimeAccess.revokeWorkspace(resourceKey);
        });
    }

    return handle;
  }

  sendControl(handle: RuntimeHandle, control: ControlPayload): void {
    const scopeKey = this.findScopeKeyByRun(handle.runId);
    if (!scopeKey) {
      this.logger.warn(
        `sandbox send control dropped ${safeLogJson({
          runId: handle.runId,
          controlType: control.type,
          reason: "no_scope",
        })}`
      );
      return;
    }
    this.pushScopeControl(scopeKey, handle.runId, control);
  }

  cancel(handle: RuntimeHandle): void {
    const scopeKey = this.findScopeKeyByRun(handle.runId);
    const scopeState = scopeKey ? this.scopeStates.get(scopeKey) : undefined;
    if (!scopeState?.runtimeResourceId) {
      this.cancelledStartingRuns.add(handle.runId);
      this.logger.debug(
        `sandbox cancel queued before ready ${safeLogJson({
          runId: handle.runId,
          scopeKey,
        })}`
      );
      return;
    }
    this.sendControl(handle, {
      type: "cancel",
      commandId: generateId(),
      runId: handle.runId,
      conversationId: handle.conversationId,
    });
  }

  getHandle(runId: string): RuntimeHandle | undefined {
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

  heartbeat(runId: string): void {
    const scopeKey = this.findScopeKeyByRun(runId);
    if (!scopeKey) return;
    this.heartbeats.beat(scopeKey);
  }

  /** worker 上报心跳时传入的 workspaceId 实际就是 AGEWORK_INTERNAL_WORKSPACE_ID（= resourceKey）。 */
  heartbeatWorkspace(workspaceId: string): void {
    this.heartbeats.beat(workspaceId);
  }

  heartbeatRuntimeResource(resourceKey: string): void {
    this.heartbeats.beat(resourceKey);
  }

  shutdownRuntimeResource(resourceKey: string): void {
    this.shutdownRuntimeResourceByKey(resourceKey);
  }

  async recoverOrphan(runtimeResourceId: string): Promise<void> {
    for (const engine of this.engines.values()) {
      await engine.recoverOrphan(runtimeResourceId).catch(
        swallow(this.logger, `recover orphan via ${engine.type} engine`)
      );
    }
  }

  cleanup(runId: string): void {
    const scopeKey = this.findScopeKeyByRun(runId);
    if (scopeKey) {
      this.scopeStates.get(scopeKey)?.activeRuns.delete(runId);
      const state = this.scopeStates.get(scopeKey);
      if (state && state.activeRuns.size === 0 && state.runtimeResourceId) {
        const idleTimeoutMs = this.configService.getIdleTimeoutSeconds() * 1000;
        this.idleWatchdog.start(scopeKey, idleTimeoutMs, () =>
          this.handleIdle(scopeKey)
        );
      }
    }
    this.runConfigStore.unregister(runId);
    this.controlQueue.cleanup(runId);
    this.runtimeAccess.revokeAccess(runId);
  }

  // ── Private helpers ──────────────────────────────────────────────────

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

  private shutdownRuntimeResourceByKey(resourceKey: string): void {
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
    this.controlQueue.cleanupWorkspace(resourceKey);
    this.controlSeqs.delete(resourceKey);
    this.scopeStates.delete(resourceKey);
    this.pendingSandboxes.delete(resourceKey);
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
  private releaseScopeRuntime(resourceKey: string, state: SandboxScopeState): void {
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
    placement: RuntimePlacement,
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

  private resourceKeyForPlacement(placement: RuntimePlacement): string {
    return placement.isolationScope === "user"
      ? placement.userId
      : placement.workspaceId;
  }

  private resolveEngine(engineType: SandboxEngineType): SandboxEngine {
    const engine = this.engines.get(engineType);
    if (!engine) {
      throw new Error(`Unknown sandbox engine: ${engineType}`);
    }
    return engine;
  }

  private findScopeKeyByRun(runId: string): string | undefined {
    for (const [scopeKey, state] of this.scopeStates) {
      if (state.activeRuns.has(runId)) return scopeKey;
    }
    return undefined;
  }

  private pushScopeControl(
    scopeKey: string,
    runId: string,
    control: ControlPayload
  ): void {
    const envelope = nextControlEnvelope(
      this.controlSeqs,
      scopeKey,
      runId,
      control
    );
    this.controlQueue.pushForWorkspace(scopeKey, envelope);
  }

  private forceCancelled(runId: string): void {
    if (this.runEventProcessor.isTerminalOrFinalizing(runId)) return;
    this.runEventProcessor
      .forceCancelledStatus(runId)
      .catch(swallow(this.logger, `force cancelled status for run ${runId}`));
  }
}
