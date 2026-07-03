import { Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type {
  AcquireInstanceResult,
  IsolationScope,
  RuntimeTarget,
  SandboxRuntimePlacement,
  WorkerExecutionStartInput,
} from "@agework/shared/protocol";
import { generateId } from "@agework/shared";
import { isSandboxPlacement } from "../../runtime/runtime.types";
import { RuntimeService } from "../../runtime/runtime.service";
import { WorkerRegistryRepository } from "../registry/worker-registry.repository";
import { WorkerCommandDispatcher } from "../command/command-dispatcher.service";
import { WorkerHandshakeStore } from "../handshake/worker-handshake.store";
import { ConfigService } from "../../config/config.service";
import { DEFAULT_WORKER_IMAGE } from "../../config/registry/defaults";
import { swallow } from "../../common/swallow";
import { withTimeout } from "../../common/with-timeout";
import { IdleWatchdog, resolveDockerApiBase } from "./sandbox-utils";
import type {
  SandboxEngineType,
  SandboxPlacement,
  SandboxRuntime,
  SandboxStartInput,
} from "../../runtime/runtime.types";
import { errorLogFields, safeLogJson } from "../../common/logging";
import { safePathPart } from "../../common/safe-path";

export type SandboxOwnerState = {
  runtimeInstanceId: string;
  /** 上次 idle/心跳超时释放时的容器 ID,供下次 start() resume;resume 成功或全新创建后清空。 */
  lastStoppedRuntimeInstanceId?: string;
  activeRunCount: number;
  isolationScope: IsolationScope;
  engineType: SandboxEngineType;
  /**
   * 注册握手共享密钥,归属这次容器"存活周期"而非单次调用:resume(`docker start`)
   * 不会更新容器创建时注入的 env,容器里跑的还是当初创建时的 worker 进程带着
   * 当初的 token,所以 token 要在同一个 ownerState 实例的生命周期内保持不变,
   * 只有 ownerState 整个被销毁重建(下次全新创建容器)才重新生成。
   */
  startToken?: string;
  /** 上一次握手成功拿到的 worker pid / 注册时间,供 recordWorkspaceRuntime 写入诊断 metadata。 */
  lastHandshakePid?: number;
  lastRegisteredAt?: string;
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
};

/**
 * 一次 run 对持久容器实例的「取得」状态:在容器就绪/失败/早取消之前持有 acquire 的
 * resolve(settle);settle 调用后置空表示已结算,state 仍保留以便 release 释放 owner
 * 引用计数。cancelled 标记取消请求早于就绪到达(由 releaseInstanceForRun 在 pending 期设置)。
 */
type AcquireRunState = {
  ownerId: string;
  cancelled: boolean;
  settle?: (result: AcquireInstanceResult) => void;
};

/**
 * sandbox 实例编排:owner 复用判断、idle watchdog、WorkerRegistry 读写——这些是
 * "要不要新开一个实例、这个 owner 现在绑的实例还活不活"的编排决策,归属 worker-manager
 * (设计文档 1.1 节)。物理 sandbox 操作(docker/opensandbox 的 getOrCreate/resume/
 * startWorker/stop)经 `RuntimeService` 转发给 `runtime` 模块,本类不直接认识
 * 具体 engine。
 */
@Injectable()
export class SandboxInstanceExecutor {
  private readonly logger = new Logger(SandboxInstanceExecutor.name);

  private readonly ownerStates = new Map<string, SandboxOwnerState>();
  private readonly acquireStates = new Map<string, AcquireRunState>();
  private readonly pendingSandboxes = new Map<
    string,
    Promise<SandboxRuntime>
  >();
  private readonly idleWatchdog = new IdleWatchdog();

  constructor(
    private readonly configService: ConfigService,
    private readonly runtimeService: RuntimeService,
    private readonly registry: WorkerRegistryRepository,
    private readonly commandDispatcher: WorkerCommandDispatcher,
    private readonly handshakeStore: WorkerHandshakeStore
  ) {}

  /**
   * 为一次 run 取得持久容器实例(创建/复用/attach),把就绪结果一次性回传 run 层执行编排。
   * 自身只管资源生命周期:发 owner accessKey、retain 引用计数、attach/start 实例;
   * worker session 的 openSession / 命令下发由 run 层在 ready 后自行对 worker-manager 完成。
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
      this.attachOrStartRuntimeInstance(context, ownerState);
    });
  }

  /**
   * 释放一次 run 对持久容器的引用。run 层在 run 终态 cleanup 时调用。
   * 若取得尚未结算(容器未就绪),仅标记 cancelled,待就绪那刻 settle 为
   * cancelledBeforeReady 并释放引用;已结算则直接释放 owner 引用计数。幂等。
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

  /** owner 容器被拆除(创建失败 / 主动停止):结算并清掉该 owner 下所有未释放的 acquire。 */
  private cleanupOwner(ownerId: string): void {
    for (const [runId, state] of this.acquireStates) {
      if (state.ownerId !== ownerId) continue;
      const settle = state.settle;
      state.settle = undefined;
      this.acquireStates.delete(runId);
      settle?.({ outcome: "error", error: "sandbox owner torn down" });
    }
    this.commandDispatcher.cleanupByOwnerId(ownerId);
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
        `SandboxInstanceExecutor requires sandbox placement, got runtimeType=${placement.runtimeType}`
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
    context: SandboxWorkerExecutionContext,
    ownerState: SandboxOwnerState
  ): void {
    if (ownerState.runtimeInstanceId) {
      this.attachReadyRuntimeInstance(context, ownerState);
      return;
    }

    const existingPending = this.pendingSandboxes.get(context.ownerId);
    if (existingPending) {
      this.attachPendingRuntimeInstance(context, existingPending);
      return;
    }

    this.startRuntimeInstanceForOwner(context, ownerState);
  }

  /** 停止并删除某 owner 的持久容器/沙箱,并清掉其 worker-manager 资源。 */
  shutdownRuntimeInstanceByOwnerId(ownerId: string): void {
    const state = this.ownerStates.get(ownerId);
    this.idleWatchdog.cancel(ownerId);
    if (state?.runtimeInstanceId) {
      this.runtimeService
        .stopSandbox(state.engineType, state.runtimeInstanceId)
        .catch(
          swallow(this.logger, `stop sandbox for runtime owner ${ownerId}`)
        );
    }
    if (state) {
      this.registry
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

  private attachReadyRuntimeInstance(
    context: SandboxWorkerExecutionContext,
    ownerState: SandboxOwnerState
  ): void {
    void this.recordWorkspaceRuntime(
      context.placement,
      context.ownerId,
      ownerState.runtimeInstanceId,
      ownerState
    );
    this.settleReady(context.runId, ownerState.runtimeInstanceId);
  }

  private attachPendingRuntimeInstance(
    context: SandboxWorkerExecutionContext,
    runtimePromise: Promise<SandboxRuntime>
  ): void {
    void runtimePromise
      .then((runtime) => {
        void this.recordWorkspaceRuntime(
          context.placement,
          context.ownerId,
          runtime.runtimeInstanceId,
          this.ownerStates.get(context.ownerId)
        );
        this.settleReady(context.runId, runtime.runtimeInstanceId);
      })
      .catch((err) => {
        this.settleError(
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
    context: SandboxWorkerExecutionContext,
    ownerState: SandboxOwnerState
  ): void {
    const runtimePromise = this.launchWithHandshake(context, ownerState);
    this.pendingSandboxes.set(context.ownerId, runtimePromise);

    void runtimePromise
      .then((runtime) => this.onRuntimeInstanceStarted(context, runtime))
      .catch((err) => this.onRuntimeInstanceStartFailed(context, err));
  }

  /**
   * 3.7 节握手状态机:先插入 starting 行(靠 Task 1 的唯一索引防并发重复
   * launch)。撞见冲突且已有行是 running——说明 API 重启导致内存丢了但容器
   * 其实还活着(sandbox 容器不随 API 进程重启而死),直接复用,不重复起；
   * 撞见冲突且已有行是 starting——同进程内真正的并发竞态早已被
   * pendingSandboxes 的同步 check-then-set 挡住,理论上不可达,报错让调用方
   * 重试即可,不做轮询等待(见计划 Architecture 一节)。
   * 插入成功后才真正调用 Provider,超时或失败都把这一行标记为 error。
   */
  private async launchWithHandshake(
    context: SandboxWorkerExecutionContext,
    ownerState: SandboxOwnerState
  ): Promise<SandboxRuntime> {
    const placeholderInstanceId = generateId();
    // token 归属容器"存活周期"而非本次调用:同一个 ownerState 实例的生命周期内
    // 只生成一次,resume 时复用——resume(docker start)不会更新容器创建时注入
    // 的 env,容器里跑的还是当初创建时带着这个 token 的 worker 进程。
    const startToken = ownerState.startToken ?? randomUUID();
    ownerState.startToken = startToken;
    const insertResult = await this.registry.insertStarting(
      {
        runtimeType: context.placement.runtimeType,
        isolationScope: context.isolationScope,
        workspaceId: context.workspaceId,
        ownerId: context.ownerId,
      },
      placeholderInstanceId,
      "http",
      startToken
    );

    if (!insertResult.ok) {
      if (insertResult.existing.status === "running") {
        return {
          engineType: context.engineType,
          runtimeInstanceId: insertResult.existing.runtimeInstanceId,
          workspaceMountPath: context.placement.sandbox.mountTarget,
        };
      }
      throw new Error(
        `owner ${context.ownerId} has a concurrent launch already starting`
      );
    }

    const engineInput = this.buildSandboxStartInput(context, startToken);
    const resumeRuntimeInstanceId = ownerState.lastStoppedRuntimeInstanceId;
    ownerState.lastStoppedRuntimeInstanceId = undefined;

    try {
      return await withTimeout(
        this.createSandbox(context, engineInput, resumeRuntimeInstanceId).then(
          (runtime) =>
            this.handshakeStore
              .waitForRegister(context.ownerId, startToken)
              .then((handshake) => {
                ownerState.lastHandshakePid = handshake.pid;
                ownerState.lastRegisteredAt = handshake.registeredAt;
                return runtime;
              })
        ),
        this.configService.getLaunchTimeoutSeconds() * 1000,
        `sandbox launch timed out for owner ${context.ownerId}`
      );
    } catch (err) {
      this.handshakeStore.cancel(
        context.ownerId,
        `sandbox launch failed for owner ${context.ownerId}`
      );
      await this.registry
        .markErrorByOwner(
          context.placement.runtimeType,
          context.isolationScope,
          context.ownerId,
          err instanceof Error ? err.message : String(err)
        )
        .catch(
          swallow(this.logger, `mark launch error for owner ${context.ownerId}`)
        );
      throw err;
    }
  }

  private buildSandboxStartInput(
    context: SandboxWorkerExecutionContext,
    startToken: string
  ): SandboxStartInput {
    const apiBase = resolveDockerApiBase();
    // 容器内日志挂载点由 placement 统一给出(run 层的 RunConfig 日志路径同源)。
    const runtimeLogDir = context.placement.runtimeLogDir;
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
        AGEWORK_WORKER_ROLE: "worker",
        AGEWORK_WORKER_API_BASE: apiBase,
        AGEWORK_WORKER_OWNER_ID: context.ownerId,
        AGEWORK_WORKER_START_TOKEN: startToken,
        AGEWORK_WORKER_RUNTIME_TYPE: "sandbox",
        AGEWORK_WORKER_SANDBOX_ENGINE: context.engineType,
        AGEWORK_WORKER_ISOLATION_SCOPE: context.isolationScope,
        AGEWORK_WORKER_RUNTIME_RESOURCE_NAME: `agework-worker-${safePathPart(
          context.ownerId
        )}`,
        AGEWORK_WORKER_LOG_DIR: runtimeLogDir,
        AGEWORK_WORKER_LOG_FILE: `${runtimeLogDir}/${safePathPart(
          context.ownerId
        )}.runtime.worker.log`,
      },
      metadata: {
        "agework.io/runtime-owner-id": context.ownerId,
        "agework.io/isolation-scope": context.isolationScope,
      },
      runtimeLogHostPath: this.configService.getRuntimeLogDir(),
      runtimeLogMountPath: runtimeLogDir,
      isExpectedRuntimeInstance: (runtimeInstanceId: string) =>
        this.registry.isRuntimeInstanceBoundToWorkspace(
          "sandbox",
          context.workspaceId,
          runtimeInstanceId
        ),
    };
  }

  private onRuntimeInstanceStarted(
    context: SandboxWorkerExecutionContext,
    runtime: SandboxRuntime
  ): void {
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
      runtime.runtimeInstanceId,
      state
    );

    this.settleReady(context.runId, runtime.runtimeInstanceId);
  }

  private onRuntimeInstanceStartFailed(
    context: SandboxWorkerExecutionContext,
    err: unknown
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
    this.settleError(context.runId, `sandbox create failed: ${String(err)}`);

    this.ownerStates.delete(context.ownerId);
    this.cleanupOwner(context.ownerId);
  }

  private async createSandbox(
    context: SandboxWorkerExecutionContext,
    input: SandboxStartInput,
    resumeRuntimeInstanceId?: string
  ): Promise<SandboxRuntime> {
    if (resumeRuntimeInstanceId) {
      try {
        const runtime = await this.runtimeService.resumeSandbox(
          context.engineType,
          resumeRuntimeInstanceId,
          input
        );
        if (runtime) return runtime;
      } catch (err) {
        this.logger.warn(
          `resume failed, falling back to fresh sandbox ${safeLogJson({
            resumeRuntimeInstanceId,
            ...errorLogFields(err),
          })}`
        );
      }
    }

    return this.runtimeService.startSandbox(context.engineType, input);
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

    this.runtimeService
      .stopSandbox(state.engineType, state.runtimeInstanceId)
      .catch(
        swallow(this.logger, `stop idle sandbox for runtime owner ${ownerId}`)
      );

    this.releaseOwnerRuntime(ownerId, state);
  }

  /**
   * 放弃对某个 runtime owner 当前容器/沙箱的引用:停止心跳与空闲计时、清空
   * activeRunCount 与 runtimeInstanceId(转存为 lastStoppedRuntimeInstanceId 供下次 resume),
   * 并将 RuntimeTarget 标记为 stopped。access key 保留,供 resume 复用。
   * 不负责真正停止/删除容器——是否需要 engine.stop() 由调用方决定。
   */
  private releaseOwnerRuntime(ownerId: string, state: SandboxOwnerState): void {
    this.idleWatchdog.cancel(ownerId);
    state.activeRunCount = 0;
    state.lastStoppedRuntimeInstanceId = state.runtimeInstanceId;
    state.runtimeInstanceId = "";

    this.registry
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
    runtimeInstanceId: string,
    ownerState?: SandboxOwnerState
  ): Promise<void> {
    return this.registry
      .upsertRunning(
        {
          runtimeType: placement.runtimeType,
          isolationScope: placement.sandbox.isolationScope,
          workspaceId: placement.workspaceId,
          ownerId,
        },
        runtimeInstanceId,
        "http",
        ownerState
          ? {
              pid: ownerState.lastHandshakePid,
              registeredAt: ownerState.lastRegisteredAt,
            }
          : undefined
      )
      .then(() => undefined)
      .catch(
        swallow(this.logger, `upsert workspace runtime for owner ${ownerId}`)
      );
  }
}
