import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { join, posix } from "node:path";
import { generateId } from "@agework/shared";
import type {
  AcquireInstanceResult,
  CommandPayload,
  ExecutionRef,
  RunConfig,
  RunPlacement,
  RuntimeHostContract,
  RuntimeHostUpstream,
  RuntimeSpec,
  SubmitRunInput,
  WorkerSnapshot,
} from "@agework/shared/protocol";
import { isRuntimeType } from "@agework/providers";
import { WorkerManagerService } from "../worker-manager.service";
import { RuntimeService } from "../../runtime/runtime.service";
import { ConfigService } from "../../config/config.service";
import { RunEventService } from "../../run-event/run-event.service";
import { WORKER_LOST_EVENT, WorkerLostEvent } from "../worker-manager.events";
import { errorLogFields } from "../../common/logging";
import { safePathPart } from "../../common/safe-path";

/** 一次已提交 run 的执行状态（原 RunDriver 状态机，随契约收编到执行面一侧）。 */
type SubmittedRunState = {
  workerId: string;
  status: "acquiring" | "ready";
  cancelled: boolean;
};

/**
 * `RuntimeHostContract` 的 Phase 1 委托实现（目标架构设计文档 §7 Phase 1）：
 * 对 run 模块只暴露 submitRun/command/releaseRun 等契约动词，内部委托现有
 * WorkerManagerService/RuntimeService——代码不搬家，先立接缝。
 *
 * 收编自 run 模块的职责（run 层从此看不见 worker）：
 * - placement → RuntimeSpec 派生与 RunConfig 组装（含 CLI 路径解析、日志路径）——
 *   执行机细节归 Host 侧（字段级决策：CLI 路径 Host 合成、RunConfig 只装业务输入）。
 * - 原 RunDriver 的取实例→openSession→user_message 编排与就绪前取消吸收。
 * - worker lost 事实经 upstream 回流（原 run 侧 WorkerLostListener 的事件桥）。
 */
@Injectable()
export class RuntimeHostAdapter implements RuntimeHostContract {
  private readonly logger = new Logger(RuntimeHostAdapter.name);
  private readonly states = new Map<string, SubmittedRunState>();
  private upstream!: RuntimeHostUpstream;

  constructor(
    private readonly workerManager: WorkerManagerService,
    private readonly runtimeService: RuntimeService,
    private readonly configService: ConfigService,
    private readonly runEvents: RunEventService
  ) {}

  setUpstream(upstream: RuntimeHostUpstream): void {
    this.upstream = upstream;
    this.workerManager.setUpstreamPort({
      sendEvent: (runId, message) => upstream.emit(runId, message),
    });
  }

  async submitRun(input: SubmitRunInput): Promise<void> {
    const { runId, placement } = input;
    if (this.states.has(runId)) return; // 幂等：同 runId 重复提交是空操作

    // spec/config 组装失败在受理前同步抛出（配置/入参问题），由调用方按启动失败处理。
    const runtimeTarget = this.resolveSpec(placement);
    const runConfig = await this.makeRunConfig(input, runtimeTarget);

    this.states.set(runId, {
      workerId: "",
      status: "acquiring",
      cancelled: false,
    });

    // 受理即返回：取得实例是异步续章，就绪/失败经 upstream 回流。
    // try/catch 把 resolveInstance 的同步异常与异步 rejection 收敛到同一失败路径。
    try {
      this.workerManager
        .resolveInstance({
          runtimeTarget,
          runConfig,
          targetRuntimeId: placement.runtimeHostId,
        })
        .then((result) =>
          this.onAcquired(runId, runConfig, runtimeTarget, result)
        )
        .catch((err) => this.onAcquireFailed(runId, err));
    } catch (err) {
      this.onAcquireFailed(runId, err);
    }
  }

  // async 是有意的：契约方法统一返回 Promise，同步 body 的异常转成 rejection。
  // eslint-disable-next-line @typescript-eslint/require-await
  async command(runId: string, payload: CommandPayload): Promise<void> {
    const state = this.states.get(runId);
    if (!state) {
      this.logger.warn("command dropped", {
        runId,
        commandType: payload.type,
        reason: "no_active_state",
      });
      return;
    }
    // 就绪前到达的 cancel 由这里吸收：标记后在 onAcquired 的 ready 分支转 cancelled 终态。
    if (payload.type === "cancel" && state.status !== "ready") {
      state.cancelled = true;
      this.workerManager.releaseInstanceForRun(runId);
      return;
    }
    this.dispatch(runId, state, payload);
  }

  releaseRun(runId: string): void {
    this.workerManager.cleanupRun(runId);
    this.workerManager.releaseInstanceForRun(runId);
    this.states.delete(runId);
  }

  async sendRecoveryCancel(input: {
    runId: string;
    conversationId: string;
    ref: ExecutionRef;
  }): Promise<void> {
    const { runId, conversationId, ref } = input;
    // native worker 是 fork 的子进程，server 重启时必随父进程一起死，发 cancel 纯属打空气。
    // 只有 sandbox 容器可能还活着，才有必要让仍在 poll 的 worker 自己收尾。
    if (ref.runtimeType === "native") return;
    const resource = await this.workerManager.findRuntimeByRuntimeId(
      ref.runtimeType,
      ref.runtimeInstanceId
    );
    if (!resource) return;
    this.workerManager.sendCommand(resource.ownerId, runId, {
      type: "cancel",
      commandId: generateId(),
      runId,
      conversationId,
    });
  }

  getWorkerSnapshotForAdmin(ref: ExecutionRef): Promise<WorkerSnapshot | null> {
    return this.workerManager.getWorkerInstanceForAdmin(
      ref.runtimeType,
      ref.runtimeInstanceId
    );
  }

  /** fence 判死的事实转发给上行端口。best-effort：失败仅记日志，不影响 fence 本身。 */
  @OnEvent(WORKER_LOST_EVENT)
  async onWorkerLost({ runId, reason }: WorkerLostEvent): Promise<void> {
    try {
      await this.upstream.notifyWorkerLost(runId, reason);
    } catch (err) {
      this.logger.warn(
        `notifyWorkerLost failed for run ${runId}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // ── 出站编排（原 RunDriver.onAcquired/onAcquireFailed） ──────────────

  private onAcquired(
    runId: string,
    runConfig: RunConfig,
    runtimeTarget: RuntimeSpec,
    result: AcquireInstanceResult
  ): void {
    const state = this.states.get(runId);
    if (!state) return;

    if (result.outcome === "error") {
      this.states.delete(runId);
      this.notifyRunFailed(runId, result.error);
      return;
    }
    // outcome === "ready"：取消早于就绪到达时，释放实例并转 cancelled 终态，不开会话。
    if (state.cancelled) {
      this.workerManager.releaseInstanceForRun(runId);
      this.states.delete(runId);
      this.upstream
        .notifyRunCancelled(runId)
        .catch((err) =>
          this.logger.warn(
            `notify run cancelled failed for run ${runId}: ${String(err)}`
          )
        );
      return;
    }

    state.workerId = result.workerId;
    state.status = "ready";
    this.upstream.notifyExecutionRef(runId, {
      runtimeType: runtimeTarget.runtimeType,
      runtimeInstanceId: result.runtimeInstanceId,
    });

    this.workerManager.openSession({
      runId,
      workerId: result.workerId,
      runConfig,
    });
    this.dispatch(runId, state, {
      type: "user_message",
      commandId: generateId(),
      runId,
    });
  }

  private onAcquireFailed(runId: string, err: unknown): void {
    this.logger.warn("resolve instance failed", {
      runId,
      ...errorLogFields(err),
    });
    this.states.delete(runId);
    this.notifyRunFailed(runId, `resolve instance failed: ${String(err)}`);
  }

  private notifyRunFailed(runId: string, error: string): void {
    this.upstream
      .notifyRunFailed(runId, error)
      .catch((err) =>
        this.logger.warn(`notify run failed for run ${runId}: ${String(err)}`)
      );
  }

  private dispatch(
    runId: string,
    state: SubmittedRunState,
    payload: CommandPayload
  ): void {
    this.workerManager.sendCommand(state.workerId, runId, payload);
    // 「命令已下发」是记账不是执行回流，直接落 run-event 账本。
    this.runEvents
      .append(
        this.runEvents.commandSent({
          runId,
          commandId: payload.commandId,
          commandType: payload.type,
        })
      )
      .catch((err) =>
        this.logger.warn("record command sent failed", {
          runId,
          commandType: payload.type,
          ...errorLogFields(err),
        })
      );
  }

  // ── placement → 执行机细节派生（原 RunLauncher.getPlacement/makeRunConfig 的
  //    执行侧半边；部署 allow-list 校验仍归 run 层，那是业务放置校验） ──────

  private resolveSpec(placement: RunPlacement): RuntimeSpec {
    const { isolation } = placement;
    if (!isRuntimeType(isolation)) {
      throw new Error(`invalid isolation: ${isolation}`);
    }
    const base = {
      userId: placement.userId,
      workspaceId: placement.workspaceId,
      workspaceRootPath: placement.workspacePath,
      userWorkspaceRootPath: this.configService.getUserWorkspace(
        placement.username
      ),
      runtimeLogHostPath: this.configService.getRuntimeLogDir(),
    };
    if (isolation === "native") {
      return this.runtimeService.resolveRuntimeSpec({
        ...base,
        runtimeType: "native",
      });
    }
    return this.runtimeService.resolveRuntimeSpec({
      ...base,
      runtimeType: isolation,
      isolationScope: placement.scope,
    });
  }

  private async makeRunConfig(
    input: SubmitRunInput,
    placement: RuntimeSpec
  ): Promise<RunConfig> {
    const { runId, conversationId, agentProviderConfig } = input;
    const workspaceId = input.placement.workspaceId;
    const logPaths = this.makeLogPaths(placement, conversationId);

    // native 的 CLI 路径由 Host 侧合成（override > detected），container 不走此链路
    // （镜像固定路径，经 env 注入）。
    let claudeExecutablePath: string | undefined;
    let codexExecutablePath: string | undefined;
    let opencodeExecutablePath: string | undefined;
    if (placement.runtimeType === "native") {
      const resolved = await this.runtimeService.getResolvedCliPaths(
        input.placement.runtimeHostId
      );
      claudeExecutablePath = resolved?.claude ?? undefined;
      codexExecutablePath = resolved?.codex ?? undefined;
      opencodeExecutablePath = resolved?.opencode ?? undefined;
    }

    return {
      runId,
      conversationId,
      workspaceId,
      runtimePath: placement.runtimePath,
      env: {},
      input: input.input,
      agentProviderConfig,
      agentEventTrace: buildAgentEventTraceConfig({
        ...this.configService.getAgentEventTraceConfig(),
        runId,
        conversationId,
        workspaceId,
        agentType: agentProviderConfig.agentType,
        ...logPaths,
      }),
      workerLogFilePath: logPaths.workerRuntimeFilePath,
      ...(claudeExecutablePath ? { claudeExecutablePath } : {}),
      ...(codexExecutablePath ? { codexExecutablePath } : {}),
      ...(opencodeExecutablePath ? { opencodeExecutablePath } : {}),
    };
  }

  private makeLogPaths(
    placement: RuntimeSpec,
    conversationId: string
  ): RuntimeLogPaths {
    const logDir = this.configService.getRuntimeLogDir();
    const conversationFileName = safePathPart(conversationId);
    const rawFileName = `${conversationFileName}.raw.jsonl`;
    const aguiFileName = `${conversationFileName}.agui.jsonl`;
    const workerFileName = `${conversationFileName}.worker.log`;
    // 运行时侧路径基于 placement.runtimeLogDir（容器挂载点或宿主机目录由 placement
    // 决定）。统一 posix join：容器必然 linux，native 下两者等价。
    const runtimeLogDir = placement.runtimeLogDir;

    return {
      logDir,
      rawFilePath: join(logDir, rawFileName),
      rawRuntimeFilePath: posix.join(runtimeLogDir, rawFileName),
      aguiFilePath: join(logDir, aguiFileName),
      aguiRuntimeFilePath: posix.join(runtimeLogDir, aguiFileName),
      workerRuntimeFilePath: posix.join(runtimeLogDir, workerFileName),
    };
  }
}

type RuntimeLogPaths = {
  logDir: string;
  rawFilePath: string;
  rawRuntimeFilePath: string;
  aguiFilePath: string;
  aguiRuntimeFilePath: string;
  workerRuntimeFilePath: string;
};

// enabled 只控制 raw/agui 大 payload 是否落 JSONL 文件。DB 关键事件索引与本开关无关。
function buildAgentEventTraceConfig(input: {
  enabled: boolean;
  maxFileMb: number;
  runId: string;
  conversationId: string;
  workspaceId: string;
  agentType: string;
  logDir: string;
  rawFilePath: string;
  rawRuntimeFilePath: string;
  aguiFilePath: string;
  aguiRuntimeFilePath: string;
}) {
  const { enabled } = input;
  return {
    enabled,
    logDir: enabled ? input.logDir : undefined,
    rawFilePath: enabled ? input.rawFilePath : undefined,
    rawRuntimeFilePath: enabled ? input.rawRuntimeFilePath : undefined,
    aguiFilePath: enabled ? input.aguiFilePath : undefined,
    aguiRuntimeFilePath: enabled ? input.aguiRuntimeFilePath : undefined,
    maxFileMb: input.maxFileMb,
    runId: input.runId,
    conversationId: input.conversationId,
    workspaceId: input.workspaceId,
    agentType: input.agentType,
  };
}
