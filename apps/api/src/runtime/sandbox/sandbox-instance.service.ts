import { Inject, Injectable, Logger } from "@nestjs/common";
import type {
  IsolationScope,
  RuntimeTarget,
  SandboxRuntimePlacement,
  WorkerExecutionHandle,
  WorkerExecutionStartInput,
} from "@agework/shared/protocol";
import { isSandboxPlacement } from "../placement/runtime-resource";
import { ConfigService } from "../../config/config.service";
import {
  CONTAINER_RUNTIME_LOG_DIR,
  DEFAULT_WORKER_IMAGE,
} from "../../config/defaults";
import type { AccessPort } from "../providers/access-port";
import { WorkspaceRuntimeInstanceRepository } from "../instances/workspace-runtime-instance.repository";
import { swallow } from "../../common/swallow";
import {
  IdleWatchdog,
  resolveDockerApiBase,
} from "./sandbox-utils";
import type {
  SandboxEngine,
  SandboxEngineType,
  SandboxPlacement,
  SandboxRuntime,
  SandboxStartInput,
} from "./sandbox-engine";
import { SANDBOX_ENGINES } from "./sandbox-engine";
import { errorLogFields, safeLogJson } from "../../common/logging";
import { safePathPart } from "../../common/safe-path";

export type SandboxOwnerState = {
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
  ownerId: string;
  isolationScope: IsolationScope;
  engineType: SandboxEngineType;
  engine: SandboxEngine;
};

export type SandboxRuntimeInstanceAttachment = {
  context: SandboxWorkerExecutionContext;
  ownerState: SandboxOwnerState;
  handle: WorkerExecutionHandle;
  onRuntimeInstanceIdReady?: (runtimeInstanceId: string) => void;
};

export type SandboxRuntimeInstanceCallbacks = {
  forceCancelled(runId: string): void;
  publishWorkerError(runId: string, error: string): void;
  cleanupByOwnerId(ownerId: string): void;
};

@Injectable()
export class SandboxRuntimeInstanceService {
  private readonly logger = new Logger(SandboxRuntimeInstanceService.name);

  private readonly ownerStates = new Map<string, SandboxOwnerState>();
  /** run 在 runtime 实例 ready 之前被取消的标记；ready 时消费并强制置 cancelled。 */
  private readonly cancelledStartingRuns = new Set<string>();
  private readonly pendingSandboxes = new Map<string, Promise<SandboxRuntime>>();
  private readonly idleWatchdog = new IdleWatchdog();
  private readonly engines: Map<SandboxEngineType, SandboxEngine>;
  private access!: AccessPort;

  constructor(
    private readonly configService: ConfigService,
    private readonly workspaceRuntimeService: WorkspaceRuntimeInstanceRepository,
    @Inject(SANDBOX_ENGINES) engines: SandboxEngine[]
  ) {
    this.engines = new Map(engines.map((e) => [e.type, e]));
  }

  /** 由 run 层经 provider 注入鉴权通道（worker-host 的 access service）。 */
  setAccessPort(access: AccessPort): void {
    this.access = access;
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
      ownerId: input.runtimeTarget.ownerId,
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

  ensureOwnerState(
    context: SandboxWorkerExecutionContext
  ): SandboxOwnerState {
    let ownerState = this.ownerStates.get(context.ownerId);
    if (!ownerState) {
      const accessKey = this.access.issueOwnerKey(
        context.ownerId
      );
      ownerState = {
        runtimeInstanceId: "",
        accessKey,
        activeRuns: new Map(),
        isolationScope: context.isolationScope,
        engineType: context.engineType,
      };
      this.ownerStates.set(context.ownerId, ownerState);
      this.idleWatchdog.cancel(context.ownerId);
      return ownerState;
    }

    if (
      !ownerState.runtimeInstanceId &&
      !this.pendingSandboxes.has(context.ownerId) &&
      !ownerState.lastStoppedRuntimeInstanceId
    ) {
      ownerState.accessKey = this.access.issueOwnerKey(
        context.ownerId
      );
      ownerState.engineType = context.engineType;
    }

    this.idleWatchdog.cancel(context.ownerId);
    return ownerState;
  }

  attachOrStartRuntimeInstance(
    attachment: SandboxRuntimeInstanceAttachment,
    callbacks: SandboxRuntimeInstanceCallbacks
  ): void {
    const { context, ownerState } = attachment;
    if (ownerState.runtimeInstanceId) {
      this.attachReadyRuntimeInstance(attachment);
      return;
    }

    const existingPending = this.pendingSandboxes.get(context.ownerId);
    if (existingPending) {
      this.attachPendingRuntimeInstance(attachment, existingPending, callbacks);
      return;
    }

    this.startRuntimeInstanceForOwner(attachment, callbacks);
  }

  findOwnerIdByRun(runId: string): string | undefined {
    for (const [ownerId, state] of this.ownerStates) {
      if (state.activeRuns.has(runId)) return ownerId;
    }
    return undefined;
  }

  getOwnerState(ownerId: string): SandboxOwnerState | undefined {
    return this.ownerStates.get(ownerId);
  }

  /** runtime 实例 ready 之前收到的 cancel：登记标记，待 ready 时统一收尾。 */
  markCancelledBeforeReady(runId: string): void {
    this.cancelledStartingRuns.add(runId);
  }

  getHandle(runId: string): WorkerExecutionHandle | undefined {
    const ownerId = this.findOwnerIdByRun(runId);
    if (!ownerId) return undefined;
    const state = this.ownerStates.get(ownerId);
    if (!state) return undefined;
    return {
      runId,
      runtimeType: "sandbox",
      runtimeInstanceId: state.runtimeInstanceId,
      conversationId: state.activeRuns.get(runId) ?? "",
    };
  }

  cleanupRun(runId: string): void {
    const ownerId = this.findOwnerIdByRun(runId);
    if (!ownerId) return;

    this.ownerStates.get(ownerId)?.activeRuns.delete(runId);
    const state = this.ownerStates.get(ownerId);
    if (state && state.activeRuns.size === 0 && state.runtimeInstanceId) {
      const idleTimeoutMs = this.configService.getIdleTimeoutSeconds() * 1000;
      this.idleWatchdog.start(ownerId, idleTimeoutMs, () =>
        this.handleIdle(ownerId)
      );
    }
  }

  shutdownRuntimeInstance(
    ownerId: string,
    callbacks: Pick<SandboxRuntimeInstanceCallbacks, "cleanupByOwnerId">
  ): void {
    const state = this.ownerStates.get(ownerId);
    this.idleWatchdog.cancel(ownerId);
    if (state?.runtimeInstanceId) {
      const engine = this.engines.get(state.engineType);
      engine?.stop(state.runtimeInstanceId).catch(
        swallow(this.logger, `stop sandbox for runtime owner ${ownerId}`)
      );
    }
    if (state) {
      this.workspaceRuntimeService
        .markStoppedByOwner(
          "sandbox",
          state.isolationScope,
          ownerId
        )
        .catch(
          swallow(
            this.logger,
            `mark runtime resource stopped for owner ${ownerId}`
          )
        );
    }
    this.access.revokeOwner(ownerId);
    callbacks.cleanupByOwnerId(ownerId);
    this.ownerStates.delete(ownerId);
    this.pendingSandboxes.delete(ownerId);
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
    const { context, ownerState, handle } = attachment;
    handle.runtimeInstanceId = ownerState.runtimeInstanceId;
    void this.recordWorkspaceRuntime(
      context.placement,
      context.ownerId,
      ownerState.runtimeInstanceId
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
        if (this.consumeCancelledStartingRun(context.runId)) {
          this.ownerStates
            .get(context.ownerId)
            ?.activeRuns.delete(context.runId);
          callbacks.forceCancelled(context.runId);
          return;
        }
        void this.recordWorkspaceRuntime(
          context.placement,
          context.ownerId,
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
            ownerId: context.ownerId,
            engineType: context.engineType,
            ...errorLogFields(err),
          })}`
        );
      });
  }

  private startRuntimeInstanceForOwner(
    attachment: SandboxRuntimeInstanceAttachment,
    callbacks: SandboxRuntimeInstanceCallbacks
  ): void {
    const { context, ownerState } = attachment;
    const engineInput = this.buildSandboxStartInput(
      context,
      ownerState.accessKey
    );
    const resumeRuntimeInstanceId = ownerState.lastStoppedRuntimeInstanceId;
    ownerState.lastStoppedRuntimeInstanceId = undefined;

    const runtimePromise = this.createSandbox(
      context,
      context.engine,
      engineInput,
      resumeRuntimeInstanceId
    );
    this.pendingSandboxes.set(context.ownerId, runtimePromise);

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
      ownerId: context.ownerId,
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
        AGEWORK_WORKER_KEEP_ALIVE: "true",
        AGEWORK_WORKER_CHANNEL: "http",
        AGEWORK_WORKER_API_BASE: apiBase,
        AGEWORK_WORKER_RUNTIME_ACCESS_KEY: accessKey,
        AGEWORK_WORKER_OWNER_ID: context.ownerId,
        AGEWORK_WORKER_RUNTIME_TYPE: "sandbox",
        AGEWORK_WORKER_SANDBOX_ENGINE: context.engineType,
        AGEWORK_WORKER_ISOLATION_SCOPE: context.isolationScope,
        AGEWORK_WORKER_RUNTIME_RESOURCE_NAME: `agework-worker-${safePathPart(
          context.ownerId
        )}`,
        AGEWORK_WORKER_LOG_DIR: CONTAINER_RUNTIME_LOG_DIR,
        AGEWORK_WORKER_LOG_FILE: `${CONTAINER_RUNTIME_LOG_DIR}/${safePathPart(
          context.ownerId
        )}.runtime.worker.log`,
      },
      metadata: {
        "agework.io/runtime-owner-id": context.ownerId,
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
    this.pendingSandboxes.delete(context.ownerId);
    const state = this.ownerStates.get(context.ownerId);
    if (!state) return;

    state.runtimeInstanceId = runtime.runtimeInstanceId;
    this.logger.log(
      `sandbox created ${safeLogJson({
        ownerId: context.ownerId,
        engine: runtime.engineType,
        resourceId: runtime.runtimeInstanceId.slice(0, 12),
        activeRuns: state.activeRuns.size,
      })}`
    );

    void this.recordWorkspaceRuntime(
      context.placement,
      context.ownerId,
      runtime.runtimeInstanceId
    );

    this.forceCancelledStartingRuns(state, callbacks);

    if (state.activeRuns.has(context.runId)) {
      handle.runtimeInstanceId = runtime.runtimeInstanceId;
      onRuntimeInstanceIdReady?.(runtime.runtimeInstanceId);
    }
  }

  private onRuntimeInstanceStartFailed(
    context: SandboxWorkerExecutionContext,
    err: unknown,
    callbacks: SandboxRuntimeInstanceCallbacks
  ): void {
    this.pendingSandboxes.delete(context.ownerId);
    this.logger.error(
      `sandbox create failed ${safeLogJson({
        runId: context.runId,
        ownerId: context.ownerId,
        engineType: context.engineType,
        ...errorLogFields(err),
      })}`
    );
    callbacks.publishWorkerError(
      context.runId,
      `sandbox create failed: ${String(err)}`
    );

    const state = this.ownerStates.get(context.ownerId);
    if (state) {
      this.forceCancelledStartingRuns(state, callbacks);
    }

    this.ownerStates.delete(context.ownerId);
    callbacks.cleanupByOwnerId(context.ownerId);
    this.access.revokeOwner(context.ownerId);
  }

  private forceCancelledStartingRuns(
    state: SandboxOwnerState,
    callbacks: SandboxRuntimeInstanceCallbacks
  ): void {
    for (const runId of state.activeRuns.keys()) {
      if (this.consumeCancelledStartingRun(runId)) {
        state.activeRuns.delete(runId);
        callbacks.forceCancelled(runId);
      }
    }
  }

  private consumeCancelledStartingRun(runId: string): boolean {
    return this.cancelledStartingRuns.delete(runId);
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

  private handleIdle(ownerId: string): void {
    const state = this.ownerStates.get(ownerId);
    if (!state || !state.runtimeInstanceId) return;
    if (state.activeRuns.size > 0) return;

    this.logger.log(
      `sandbox idle timeout ${safeLogJson({
        ownerId,
        resourceId: state.runtimeInstanceId.slice(0, 12),
        engineType: state.engineType,
      })}`
    );

    const engine = this.engines.get(state.engineType);
    engine?.stop(state.runtimeInstanceId).catch(
      swallow(this.logger, `stop idle sandbox for runtime owner ${ownerId}`)
    );

    this.releaseOwnerRuntime(ownerId, state);
  }

  /**
   * 放弃对某个 runtime owner 当前容器/沙箱的引用：停止心跳与空闲计时、清空
   * activeRuns 与 runtimeInstanceId（转存为 lastStoppedRuntimeInstanceId 供下次 resume），
   * 并将 RuntimeTarget 标记为 stopped。access key 保留，供 resume 复用。
   * 不负责真正停止/删除容器——是否需要 engine.stop() 由调用方决定。
   */
  private releaseOwnerRuntime(
    ownerId: string,
    state: SandboxOwnerState
  ): void {
    this.idleWatchdog.cancel(ownerId);
    state.activeRuns.clear();
    state.lastStoppedRuntimeInstanceId = state.runtimeInstanceId;
    state.runtimeInstanceId = "";

    this.workspaceRuntimeService
      .markStoppedByOwner(
        "sandbox",
        state.isolationScope,
        ownerId
      )
      .catch(
        swallow(
          this.logger,
          `mark runtime resource stopped for owner ${ownerId}`
        )
      );
  }

  private recordWorkspaceRuntime(
    placement: SandboxRuntimePlacement,
    ownerId: string,
    runtimeInstanceId: string
  ): Promise<void> {
    return this.workspaceRuntimeService
      .upsertRunning(placement, ownerId, runtimeInstanceId)
      .then(() => undefined)
      .catch(
        swallow(
          this.logger,
          `upsert workspace runtime for owner ${ownerId}`
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
    this.access.issueRuntimeInstanceKey(
      runtimeInstanceId,
      context.ownerId
    );
  }
}
