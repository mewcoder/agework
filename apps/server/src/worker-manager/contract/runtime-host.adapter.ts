import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { join, posix } from "node:path";
import { generateId } from "@agework/shared";
import { parseOwnerKey } from "@agework/shared/protocol";
import type {
  AcquireInstanceResult,
  CommandPayload,
  CreateDirectoryInput,
  DirectoryListing,
  ExecutionRef,
  HostCapabilityStatus,
  HostUpstreamNotification,
  InstallCliInput,
  InstallCliResult,
  ListChangedFilesInput,
  ListDirectoryInput,
  OwnerKey,
  ReadFileDiffInput,
  ReadFileInput,
  RunConfig,
  RunPlacement,
  RuntimeHostContract,
  RuntimeHostUpstream,
  RuntimeSpec,
  SearchFilesInput,
  SubmitRunInput,
  WorkerKey,
  WorkerScope,
  WorkerSnapshot,
  WorkspaceFileQuery,
} from "@agework/shared/protocol";
import type {
  RuntimeEnvConfig,
  WorkspaceChangedFilesResponse,
  WorkspaceFileDiffResponse,
  WorkspaceFileListResponse,
  WorkspaceFileReadResponse,
  WorkspaceFileSearchResponse,
} from "@agework/shared/api";
import { isRuntimeType } from "@agework/providers";
import { WorkerManagerService } from "../worker-manager.service";
import { RuntimeService } from "../../runtime/runtime.service";
import { RuntimeTunnelHandler } from "../../runtime/gateway/runtime-tunnel.handler";
import { isManagedRuntimeId } from "../../runtime/runtime.types";
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
  /** Phase 2: 记录该 run 的 Host id，供 command 路由用。 */
  runtimeHostId: string;
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
    private readonly tunnelHandler: RuntimeTunnelHandler,
    private readonly configService: ConfigService,
    private readonly runEvents: RunEventService
  ) {}

  setUpstream(upstream: RuntimeHostUpstream): void {
    this.upstream = upstream;
    this.workerManager.setUpstreamPort({
      sendEvent: (runId, message) => upstream.emit(runId, message),
    });
    // Phase 2: 注册隧道上游通知回调——registered Host 的事件经隧道回流
    this.tunnelHandler.setUpstreamHandler((runtimeId, notification) => {
      this.onTunnelUpstream(runtimeId, notification, upstream);
    });
  }

  async submitRun(input: SubmitRunInput): Promise<void> {
    const { runId, placement } = input;
    if (this.states.has(runId)) return; // 幂等：同 runId 重复提交是空操作

    // Phase 2 双栈：registered Host 走隧道，managed Host 走旧 worker-manager 路径
    if (!isManagedRuntimeId(placement.runtimeHostId)) {
      await this.submitRunViaTunnel(input);
      return;
    }

    // spec/config 组装失败在受理前同步抛出（配置/入参问题），由调用方按启动失败处理。
    const runtimeTarget = this.resolveSpec(placement);
    const runConfig = await this.makeRunConfig(input, runtimeTarget);

    this.states.set(runId, {
      workerId: "",
      status: "acquiring",
      cancelled: false,
      runtimeHostId: placement.runtimeHostId,
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
    // Phase 2 双栈：registered Host 走隧道
    if (!isManagedRuntimeId(state.runtimeHostId)) {
      await this.commandViaTunnel(state.runtimeHostId, runId, payload);
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

  // ── Phase 2 双栈：registered Host 隧道路径 ──────────────────────────

  /** 通过隧道向 registered Host 发 submitRun。 */
  private async submitRunViaTunnel(input: SubmitRunInput): Promise<void> {
    const { runId, placement } = input;
    this.states.set(runId, {
      workerId: "",
      status: "ready", // registered Host 自己管 worker 生命周期，server 侧不需要 acquiring 状态
      cancelled: false,
      runtimeHostId: placement.runtimeHostId,
    });
    try {
      const timeoutMs = this.configService.getLaunchTimeoutSeconds() * 1000;
      await this.tunnelHandler.sendRequest(
        placement.runtimeHostId,
        {
          jsonrpc: "2.0",
          id: runId,
          method: "host.submitRun",
          params: input,
        },
        timeoutMs
      );
    } catch (err) {
      this.states.delete(runId);
      this.upstream
        .notifyRunFailed(runId, `tunnel submitRun failed: ${String(err)}`)
        .catch(() => {});
    }
  }

  /** 通过隧道向 registered Host 发 command。 */
  private async commandViaTunnel(
    runtimeHostId: string,
    runId: string,
    payload: CommandPayload
  ): Promise<void> {
    try {
      const timeoutMs = this.configService.getLaunchTimeoutSeconds() * 1000;
      await this.tunnelHandler.sendRequest(
        runtimeHostId,
        {
          jsonrpc: "2.0",
          id: `${runId}:${payload.commandId}`,
          method: "host.command",
          params: { runId, payload },
        },
        timeoutMs
      );
    } catch (err) {
      this.logger.warn(`tunnel command failed for run ${runId}: ${String(err)}`);
    }
  }

  /** 隧道 upstream 通知 → RuntimeHostUpstream 回流。 */
  private onTunnelUpstream(
    _runtimeId: string,
    notification: HostUpstreamNotification,
    upstream: RuntimeHostUpstream
  ): void {
    switch (notification.kind) {
      case "emit":
        upstream.emit(notification.runId, notification.message).catch(() => {});
        break;
      case "runFailed":
        upstream.notifyRunFailed(notification.runId, notification.error).catch(() => {});
        break;
      case "runCancelled":
        upstream.notifyRunCancelled(notification.runId).catch(() => {});
        break;
      case "workerLost":
        upstream.notifyWorkerLost(notification.runId, notification.reason).catch(() => {});
        break;
      case "executionRef":
        upstream.notifyExecutionRef(notification.runId, notification.ref);
        break;
    }
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

  // ── Phase 2 expand: 环境 / 文件 / 观测 契约方法 ─────────────────────
  //
  // 过渡委托实现：直接调 RuntimeService.runtimeFor(id) 拿到 Runtime 接口实例，
  // 调其文件/环境方法。authorization 在 server controller 层完成，这里不做 owner 校验。
  // Phase 2 per-Host 实例就绪后，这些方法由 Host 自身实现，不经过 RuntimeService。

  async releaseOwner(owner: OwnerKey): Promise<void> {
    const { scope, id } = parseOwnerKey(owner);
    // 过渡：owner key 的 id 部分就是旧模型的 ownerId（workspaceId 或 userId）。
    // 找到该 owner 名下所有 running worker 并 stop。幂等——无 worker 时空操作。
    const resources = await this.workerManager.listResources({
      status: "running",
      pageSize: 1000,
    });
    const matching = resources.list.filter((r) => r.ownerId === id);
    for (const resource of matching) {
      try {
        await this.workerManager.stopWorkerInstance(resource.id);
      } catch (err) {
        this.logger.warn(`stopWorkerInstance failed during releaseOwner: ${String(err)}`);
      }
    }
    void scope; // scope 过渡期不参与路由——旧模型按 ownerId 直查
  }

  async detectEnv(runtimeHostId: string): Promise<HostCapabilityStatus> {
    const row = await this.runtimeService.getRuntimeRow(runtimeHostId);
    if (!row) {
      throw new Error(`runtime host not found: ${runtimeHostId}`);
    }
    const runtimeType = row.runtimeType ?? "native";
    const caps = row.capabilities as { isolationScopes?: string[] } | null;
    const scopes = (caps?.isolationScopes ?? ["workspace"]).filter(
      (s): s is WorkerScope => s === "workspace" || s === "user"
    );
    const envConfig = row.envConfig as RuntimeEnvConfig | null;

    // 过渡：当前一 Runtime 行只代表一种 runtimeType，构造单条目 HostCapabilityStatus。
    // Phase 2 per-Host 实例会返回完整能力矩阵（多 isolation）。
    const status: HostCapabilityStatus = {
      [runtimeType]: {
        available: true,
        scopes: scopes.length > 0 ? scopes : ["workspace"],
        ...(runtimeType === "native" && envConfig
          ? { cli: envConfig }
          : {}),
      },
    };
    return status;
  }

  async installCli(input: InstallCliInput): Promise<InstallCliResult> {
    const { runtimeHostId, agentType } = input;
    const result = await this.runtimeService.installCli(runtimeHostId, agentType);
    if (!result.envConfig) {
      throw new Error(`installCli failed: no envConfig returned for ${runtimeHostId}`);
    }
    return { envConfig: result.envConfig };
  }

  async listDirectory(input: ListDirectoryInput): Promise<DirectoryListing> {
    const { runtimeHostId, path } = input;
    const result = await this.runtimeService
      .runtimeFor(runtimeHostId)
      .listDirectory(path);
    return { path: result.path, entries: result.entries };
  }

  async createDirectory(input: CreateDirectoryInput): Promise<void> {
    const { runtimeHostId, path } = input;
    await this.runtimeService.runtimeFor(runtimeHostId).createDirectory(path);
  }

  async listFiles(input: WorkspaceFileQuery): Promise<WorkspaceFileListResponse> {
    return this.runtimeService
      .runtimeFor(input.runtimeHostId)
      .listFiles(input.rootPath, input.path);
  }

  async readFile(input: ReadFileInput): Promise<WorkspaceFileReadResponse> {
    return this.runtimeService
      .runtimeFor(input.runtimeHostId)
      .readFile(input.rootPath, input.path);
  }

  async readFileDiff(input: ReadFileDiffInput): Promise<WorkspaceFileDiffResponse> {
    return this.runtimeService
      .runtimeFor(input.runtimeHostId)
      .readFileDiff(input.rootPath, input.path);
  }

  async searchFiles(input: SearchFilesInput): Promise<WorkspaceFileSearchResponse> {
    return this.runtimeService
      .runtimeFor(input.runtimeHostId)
      .searchFiles(input.rootPath);
  }

  async listChangedFiles(
    input: ListChangedFilesInput
  ): Promise<WorkspaceChangedFilesResponse> {
    return this.runtimeService
      .runtimeFor(input.runtimeHostId)
      .listChangedFiles(input.rootPath);
  }

  async listWorkers(): Promise<WorkerSnapshot[]> {
    const resources = await this.workerManager.listResources({
      pageSize: 1000,
    });
    return resources.list.map((r) => ({
      id: r.id,
      runtimeType: r.runtimeType,
      isolationScope: r.isolationScope,
      ownerId: r.ownerId,
      runtimeInstanceId: r.runtimeInstanceId,
      status: r.status,
      expiresAt: r.expiresAt,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      workspaceBindings: r.workspaceBindings ?? [],
    }));
  }

  async stopWorker(key: WorkerKey): Promise<void> {
    // WorkerKey = `${OwnerKey}#${Isolation}`。过渡：从 listWorkers 找匹配的 worker 停掉。
    // Phase 2 per-Host 实例直接从内存池按 key 查。
    const workers = await this.listWorkers();
    const ownerPart = key.split("#")[0];
    const isolationPart = key.split("#")[1];
    const { id: ownerId } = parseOwnerKey(
      ownerPart as OwnerKey
    );
    const matching = workers.filter(
      (w) =>
        w.ownerId === ownerId && w.runtimeType === isolationPart
    );
    for (const worker of matching) {
      try {
        await this.workerManager.stopWorkerInstance(worker.id);
      } catch (err) {
        this.logger.warn(`stopWorker failed for ${key}: ${String(err)}`);
      }
    }
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
