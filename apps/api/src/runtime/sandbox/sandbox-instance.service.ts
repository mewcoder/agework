import { Inject, Injectable, Logger } from "@nestjs/common";
import type {
  AcquireInstanceResult,
  IsolationScope,
  RuntimeTarget,
  SandboxRuntimePlacement,
  WorkerExecutionStartInput,
} from "@agework/shared/protocol";
import { isSandboxPlacement } from "../placement/runtime-resource";
import { WorkerHostService } from "../../worker-host/worker-host.service";
import { ConfigService } from "../../config/config.service";
import {
  CONTAINER_RUNTIME_LOG_DIR,
  DEFAULT_WORKER_IMAGE,
} from "../../config/registry/defaults";
import { WorkspaceRuntimeInstanceRepository } from "../instances/workspace-runtime-instance.repository";
import { swallow } from "../../common/swallow";
import { IdleWatchdog, resolveDockerApiBase } from "./sandbox-utils";
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
  activeRunCount: number;
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
};

export type SandboxRuntimeInstanceCallbacks = {
  runtimeReady(runId: string, runtimeInstanceId: string): void;
  publishWorkerError(runId: string, error: string): void;
  cleanupByOwnerId(ownerId: string): void;
};

/**
 * 一次 run 对持久容器实例的「取得」状态：在容器就绪/失败/早取消之前持有 acquire 的
 * resolve（settle）；settle 调用后置空表示已结算，state 仍保留以便 release 释放 owner
 * 引用计数。cancelled 标记取消请求早于就绪到达（由 releaseInstanceForRun 在 pending 期设置）。
 */
type AcquireRunState = {
  ownerId: string;
  cancelled: boolean;
  settle?: (result: AcquireInstanceResult) => void;
};

@Injectable()
export class SandboxRuntimeInstanceService {
  private readonly logger = new Logger(SandboxRuntimeInstanceService.name);

  private readonly ownerStates = new Map<string, SandboxOwnerState>();
  private readonly acquireStates = new Map<string, AcquireRunState>();
  private readonly pendingSandboxes = new Map<
    string,
    Promise<SandboxRuntime>
  >();
  private readonly idleWatchdog = new IdleWatchdog();
  private readonly engines: Map<SandboxEngineType, SandboxEngine>;

  constructor(
    private readonly configService: ConfigService,
    private readonly workspaceRuntimeService: WorkspaceRuntimeInstanceRepository,
    private readonly workerHost: WorkerHostService,
    @Inject(SANDBOX_ENGINES) engines: SandboxEngine[]
  ) {
    this.engines = new Map(engines.map((e) => [e.type, e]));
  }

  /**
   * 为一次 run 取得持久容器实例（创建/复用/attach），把就绪结果一次性回传 run 层执行编排。
   * 自身只管资源生命周期：发 owner accessKey、retain 引用计数、attach/start 实例；
   * worker session 的 openSession / 命令下发由 run 层在 ready 后自行对 worker-host 完成。
   */
  acquireInstanceForRun(
    input: WorkerExecutionStartInput
  ): Promise<AcquireInstanceResult> {
    const context = this.resolveWorkerExecutionContext(input);
    this.logWorkerExecutionStart(context);
    const ownerState = this.ensureOwnerState(context);
    this.retainOwnerRun(context.ownerId);
    return new Promise<AcquireInstanceResult>((resolve) => {
      this.acquireStates.set(context.runId, {
        ownerId: context.ownerId,
        cancelled: false,
        settle: resolve,
      });
      this.attachOrStartRuntimeInstance(
        { context, ownerState },
        this.acquireCallbacks()
      );
    });
  }

  /**
   * 释放一次 run 对持久容器的引用。run 层在 run 终态 cleanup 时调用。
   * 若取得尚未结算（容器未就绪），仅标记 cancelled，待就绪那刻 settle 为
   * cancelledBeforeReady 并释放引用；已结算则直接释放 owner 引用计数。幂等。
   */
  releaseInstanceForRun(runId: string): void {
    const state = this.acquireStates.get(runId);
    if (!state) return;
    if (state.settle) {
      state.cancelled = true;
      return;
    }
    this.releaseOwnerRun(state.ownerId);
    this.acquireStates.delete(runId);
  }

  private acquireCallbacks(): SandboxRuntimeInstanceCallbacks {
    return {
      runtimeReady: (runId, runtimeInstanceId) =>
        this.settleReady(runId, runtimeInstanceId),
      publishWorkerError: (runId, error) => this.settleError(runId, error),
      cleanupByOwnerId: (ownerId) => this.cleanupOwner(ownerId),
    };
  }

  private settleReady(runId: string, runtimeInstanceId: string): void {
    const state = this.acquireStates.get(runId);
    if (!state?.settle) return;
    const settle = state.settle;
    state.settle = undefined;
    if (state.cancelled) {
      this.releaseOwnerRun(state.ownerId);
      this.acquireStates.delete(runId);
      settle({ outcome: "cancelledBeforeReady" });
      return;
    }
    settle({ outcome: "ready", runtimeInstanceId });
  }

  private settleError(runId: string, error: string): void {
    const state = this.acquireStates.get(runId);
    if (!state?.settle) return;
    const settle = state.settle;
    state.settle = undefined;
    settle({ outcome: "error", error });
  }

  /** owner 容器被拆除（创建失败 / 主动停止）：结算并清掉该 owner 下所有未释放的 acquire。 */
  private cleanupOwner(ownerId: string): void {
    for (const [runId, state] of this.acquireStates) {
      if (state.ownerId !== ownerId) continue;
      const settle = state.settle;
      state.settle = undefined;
      this.acquireStates.delete(runId);
      settle?.({ outcome: "error", error: "sandbox owner torn down" });
    }
    this.workerHost.cleanupByOwnerId(ownerId);
  }

  private logWorkerExecutionStart(
    context: SandboxWorkerExecutionContext
  ): void {
    this.logger.log(
      `sandbox run starting ${safeLogJson({
        runId: context.runId,
        conversationId: context.runConfig.conversationId,
        workspaceId: context.workspaceId,
        ownerId: context.ownerId,
        isolationScope: context.isolationScope,
        engineType: context.engineType,
      })}`
    );
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
      placement.sandbox.sandboxEngineType ??
      this.configService.getSandboxEngine();
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

  private ensureOwnerState(
    context: SandboxWorkerExecutionContext
  ): SandboxOwnerState {
    let ownerState = this.ownerStates.get(context.ownerId);
    if (!ownerState) {
      ownerState = {
        runtimeInstanceId: "",
        activeRunCount: 0,
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
      ownerState.engineType = context.engineType;
    }

    this.idleWatchdog.cancel(context.ownerId);
    return ownerState;
  }

  private retainOwnerRun(ownerId: string): void {
    const ownerState = this.ownerStates.get(ownerId);
    if (!ownerState) return;
    ownerState.activeRunCount += 1;
    this.idleWatchdog.cancel(ownerId);
  }

  private releaseOwnerRun(ownerId: string): void {
    const state = this.ownerStates.get(ownerId);
    if (!state) return;
    state.activeRunCount = Math.max(0, state.activeRunCount - 1);
    if (state.activeRunCount === 0 && state.runtimeInstanceId) {
      const idleTimeoutMs = this.configService.getIdleTimeoutSeconds() * 1000;
      this.idleWatchdog.start(ownerId, idleTimeoutMs, () =>
        this.handleIdle(ownerId)
      );
    }
  }

  private attachOrStartRuntimeInstance(
    attachment: SandboxRuntimeInstanceAttachment,
    callbacks: SandboxRuntimeInstanceCallbacks
  ): void {
    const { context, ownerState } = attachment;
    if (ownerState.runtimeInstanceId) {
      this.attachReadyRuntimeInstance(attachment, callbacks);
      return;
    }

    const existingPending = this.pendingSandboxes.get(context.ownerId);
    if (existingPending) {
      this.attachPendingRuntimeInstance(attachment, existingPending, callbacks);
      return;
    }

    this.startRuntimeInstanceForOwner(attachment, callbacks);
  }

  /** 停止并删除某 owner 的持久容器/沙箱，并清掉其 worker-host 资源。 */
  shutdownRuntimeInstanceByOwnerId(ownerId: string): void {
    const state = this.ownerStates.get(ownerId);
    this.idleWatchdog.cancel(ownerId);
    if (state?.runtimeInstanceId) {
      const engine = this.engines.get(state.engineType);
      engine
        ?.stop(state.runtimeInstanceId)
        .catch(
          swallow(this.logger, `stop sandbox for runtime owner ${ownerId}`)
        );
    }
    if (state) {
      this.workspaceRuntimeService
        .markStoppedByOwner("sandbox", state.isolationScope, ownerId)
        .catch(
          swallow(
            this.logger,
            `mark runtime resource stopped for owner ${ownerId}`
          )
        );
    }
    this.cleanupOwner(ownerId);
    this.ownerStates.delete(ownerId);
    this.pendingSandboxes.delete(ownerId);
  }

  async recoverOrphan(runtimeInstanceId: string): Promise<void> {
    for (const engine of this.engines.values()) {
      await engine
        .recoverOrphan(runtimeInstanceId)
        .catch(
          swallow(this.logger, `recover orphan via ${engine.type} engine`)
        );
    }
  }

  private attachReadyRuntimeInstance(
    attachment: SandboxRuntimeInstanceAttachment,
    callbacks: SandboxRuntimeInstanceCallbacks
  ): void {
    const { context, ownerState } = attachment;
    void this.recordWorkspaceRuntime(
      context.placement,
      context.ownerId,
      ownerState.runtimeInstanceId
    );
    callbacks.runtimeReady(context.runId, ownerState.runtimeInstanceId);
  }

  private attachPendingRuntimeInstance(
    attachment: SandboxRuntimeInstanceAttachment,
    runtimePromise: Promise<SandboxRuntime>,
    callbacks: SandboxRuntimeInstanceCallbacks
  ): void {
    const { context } = attachment;
    void runtimePromise
      .then((runtime) => {
        void this.recordWorkspaceRuntime(
          context.placement,
          context.ownerId,
          runtime.runtimeInstanceId
        );
        callbacks.runtimeReady(context.runId, runtime.runtimeInstanceId);
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
    const engineInput = this.buildSandboxStartInput(context);
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
    context: SandboxWorkerExecutionContext
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
      env: {
        AGEWORK_WORKER_KEEP_ALIVE: "true",
        AGEWORK_WORKER_CHANNEL: "http",
        AGEWORK_WORKER_API_BASE: apiBase,
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
    const { context } = attachment;
    this.pendingSandboxes.delete(context.ownerId);
    const state = this.ownerStates.get(context.ownerId);
    if (!state) return;

    state.runtimeInstanceId = runtime.runtimeInstanceId;
    this.logger.log(
      `sandbox created ${safeLogJson({
        ownerId: context.ownerId,
        engine: runtime.engineType,
        resourceId: runtime.runtimeInstanceId.slice(0, 12),
        activeRunCount: state.activeRunCount,
      })}`
    );

    void this.recordWorkspaceRuntime(
      context.placement,
      context.ownerId,
      runtime.runtimeInstanceId
    );

    callbacks.runtimeReady(context.runId, runtime.runtimeInstanceId);
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

    this.ownerStates.delete(context.ownerId);
    callbacks.cleanupByOwnerId(context.ownerId);
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
    await engine.startWorker(runtime, input);
    return runtime;
  }

  private handleIdle(ownerId: string): void {
    const state = this.ownerStates.get(ownerId);
    if (!state || !state.runtimeInstanceId) return;
    if (state.activeRunCount > 0) return;

    this.logger.log(
      `sandbox idle timeout ${safeLogJson({
        ownerId,
        resourceId: state.runtimeInstanceId.slice(0, 12),
        engineType: state.engineType,
      })}`
    );

    const engine = this.engines.get(state.engineType);
    engine
      ?.stop(state.runtimeInstanceId)
      .catch(
        swallow(this.logger, `stop idle sandbox for runtime owner ${ownerId}`)
      );

    this.releaseOwnerRuntime(ownerId, state);
  }

  /**
   * 放弃对某个 runtime owner 当前容器/沙箱的引用：停止心跳与空闲计时、清空
   * activeRunCount 与 runtimeInstanceId（转存为 lastStoppedRuntimeInstanceId 供下次 resume），
   * 并将 RuntimeTarget 标记为 stopped。access key 保留，供 resume 复用。
   * 不负责真正停止/删除容器——是否需要 engine.stop() 由调用方决定。
   */
  private releaseOwnerRuntime(ownerId: string, state: SandboxOwnerState): void {
    this.idleWatchdog.cancel(ownerId);
    state.activeRunCount = 0;
    state.lastStoppedRuntimeInstanceId = state.runtimeInstanceId;
    state.runtimeInstanceId = "";

    this.workspaceRuntimeService
      .markStoppedByOwner("sandbox", state.isolationScope, ownerId)
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
        swallow(this.logger, `upsert workspace runtime for owner ${ownerId}`)
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
