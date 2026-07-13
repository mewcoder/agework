import { randomUUID } from "node:crypto";
import { join, posix } from "node:path";
import type {
  AcquireInstanceResult,
  AgentProviderConfig,
  CommandPayload,
  CreateDirectoryInput,
  DirectoryListing,
  ExecutionRef,
  HostCapabilityStatus,
  InstallCliInput,
  InstallCliResult,
  ListChangedFilesInput,
  ListDirectoryInput,
  OwnerKey,
  ReadFileDiffInput,
  ReadFileInput,
  RunChannelMessage,
  RunConfig,
  RunPlacement,
  RuntimeHostContract,
  RuntimeHostUpstream,
  RuntimeSpec,
  SearchFilesInput,
  SubmitRunInput,
  WorkerKey,
  WorkerSnapshot,
  WorkspaceFileQuery,
} from "@agework/shared/protocol";
import { generateId } from "@agework/shared";
import { parseOwnerKey, workerKey } from "@agework/shared/protocol";
import type {
  RuntimeEnvConfig,
  WorkspaceChangedFilesResponse,
  WorkspaceFileDiffResponse,
  WorkspaceFileListResponse,
  WorkspaceFileReadResponse,
  WorkspaceFileSearchResponse,
} from "@agework/shared/api";
import type { AgentEventTraceConfig } from "@agework/shared/protocol";
import {
  createRuntimeResolver,
  isRuntimeType,
  type RuntimeConfig,
  type RuntimeInstanceRef,
  type RuntimeLaunchContext,
  type RuntimeProvider,
  type RuntimeType,
} from "@agework/providers";
import { resolveRuntimeSpec } from "@agework/providers";
import { detectEnvConfig } from "@agework/shared/cli";
import {
  listFiles as listFilesDirect,
  readFile as readFileDirect,
  searchFiles as searchFilesDirect,
  createFsTimeoutSignal,
} from "@agework/shared/filesystem";
import {
  listChangedFiles as listChangedFilesDirect,
  readFileDiff as readFileDiffDirect,
} from "@agework/shared/git";
import {
  isWorkerCommandResultRpcResponse,
  isWorkerEventRpcNotification,
  rpcNotificationToUpstreamMessage,
  rpcResponseToCommandResultMessage,
} from "@agework/shared/protocol/rpc";
import { WorkerPool, type WorkerEntry } from "./worker-pool";
import { CommandMailbox } from "./command-mailbox";
import { HandshakeStore } from "./handshake-store";
import {
  createDirectory as createDirectoryOnDisk,
  listDirectory as listDirectoryOnDisk,
} from "../filesystem/directory-browser";

/**
 * RuntimeHost 的配置：由 server 侧（builtin 场景）或 daemon 侧（registered 场景）提供。
 */
export interface RuntimeHostConfig {
  /** 日志目录（宿主机路径）。 */
  runtimeLogDir: string;
  /** 按 username 返回用户工作空间根目录。 */
  getUserWorkspace(username: string): string;
  /** worker 启动超时（ms）。 */
  launchTimeoutMs: number;
  /** 心跳判死超时（ms）。 */
  heartbeatTimeoutMs: number;
  /** agent event trace 配置。 */
  agentEventTrace: { enabled: boolean; maxFileMb: number };
  /** Runtime provider 配置（传给 @agework/providers）。 */
  providerConfig: RuntimeConfig;
  /**
   * worker 回连 Host 的 HTTP 基地址（如 `http://0.0.0.0:7101/api/v1`）。
   * worker 的 AGEWORK_WORKER_API_BASE 设为此值，使 worker 数据面对端从 server 切到 Host。
   * builtin 场景（进程内）可省略——worker 仍连 server 旧端点。
   */
  workerApiBaseUrl?: string;
  /**
   * native 隔离的 agent CLI 路径解析（override > detected）。Host 是执行机器本机,
   * 由宿主注入:builtin 用 server 的 RuntimeService 解析,daemon 用本机 detectEnvConfig。
   * 未提供时 RunConfig 不带 CLI 路径,worker 退回 PATH 查找。
   */
  resolveCliPaths?: () => Promise<{
    claude: string | null;
    codex: string | null;
    opencode: string | null;
  }>;
  /** 命令下发审计钩子(builtin 场景由 server 接到 run-event 账本;daemon 场景不设)。 */
  onCommandDispatched?: (info: {
    runId: string;
    commandId: string;
    commandType: string;
  }) => void;
}

/**
 * 一次已提交 run 的执行状态。
 */
type SubmittedRunState = {
  workerId: string;
  status: "acquiring" | "ready";
  cancelled: boolean;
};

/**
 * RuntimeHost：部署在一台执行机器上的常驻执行节点。
 *
 * 实现 `RuntimeHostContract`，内部管理 worker 池（`Map<WorkerKey, WorkerEntry>`）、
 * 命令信箱、握手、fence。一台机器 = 一个 Host = 一行注册 = 一条隧道。
 *
 * 两种宿主：
 * - **库入口**（builtin）：server 进程内直接 `new` 出本类，进程内调用。
 * - **daemon 入口**（registered）：远程机器跑同一套代码，主动外连 server 建隧道。
 *
 * 同一实现、两种宿主。不依赖 NestJS。
 */
export class RuntimeHost implements RuntimeHostContract {
  private readonly pool = new WorkerPool();
  private readonly mailbox = new CommandMailbox();
  private readonly handshakes = new HandshakeStore();
  private readonly states = new Map<string, SubmittedRunState>();
  private readonly commandSeqs = new Map<string, number>();
  private readonly runConfigs = new Map<string, RunConfig>();
  private readonly fenceTimer: ReturnType<typeof setInterval> | undefined;
  private upstream!: RuntimeHostUpstream;
  private readonly resolveProvider: (type: RuntimeType) => RuntimeProvider;
  // 不用 constructor parameter property:server dev 以 Node strip-only TS
  // 直接加载本文件,strip-only 不支持 parameter property 语法。
  private readonly config: RuntimeHostConfig;

  constructor(config: RuntimeHostConfig) {
    this.config = config;
    this.resolveProvider = createRuntimeResolver(config.providerConfig);
    // 心跳判死定时器：定期扫描 pool，超时未见心跳即判死。
    const interval = Math.max(1000, Math.floor(config.heartbeatTimeoutMs / 3));
    this.fenceTimer = setInterval(() => this.sweepFence(), interval);
    this.fenceTimer.unref?.();
  }

  setUpstream(upstream: RuntimeHostUpstream): void {
    this.upstream = upstream;
  }

  // ── 执行 ────────────────────────────────────────────────────────────

  async submitRun(input: SubmitRunInput): Promise<void> {
    const { runId, placement } = input;
    if (this.states.has(runId)) return; // 幂等

    // spec/config 组装失败同步抛出(配置/入参问题),由调用方按启动失败处理。
    // 每次 run 都建 RunConfig(不只新建 worker 时)——复用已有 worker 的 run
    // 同样要能被 worker 经 getRunConfig 拉到自己的配置。
    const runtimeTarget = this.resolveSpec(placement);
    const runConfig = await this.makeRunConfig(input, runtimeTarget);
    this.runConfigs.set(runId, runConfig);

    const wKey = workerKey(placement.owner, placement.isolation);
    const existing = this.pool.get(wKey);

    this.states.set(runId, {
      workerId: existing?.workerId ?? "",
      status: existing?.status === "ready" ? "ready" : "acquiring",
      cancelled: false,
    });

    if (existing?.status === "ready") {
      // 复用已有 worker
      this.onWorkerReady(runId, existing, input);
      return;
    }

    // 异步取得 worker——受理即返回
    this.acquireWorker(input, wKey, runtimeTarget, runConfig).then(
      (entry) => this.onAcquired(runId, input, wKey, entry),
      (err) => this.onAcquireFailed(runId, err)
    );
  }

  async command(runId: string, payload: CommandPayload): Promise<void> {
    const state = this.states.get(runId);
    if (!state) return;

    if (payload.type === "cancel" && state.status !== "ready") {
      // 就绪前 cancel：标记，就绪时转 cancelled
      const wKey = this.pool.getByRunId(runId)?.key;
      if (wKey) this.pool.markCancelled(wKey, runId);
      state.cancelled = true;
      return;
    }

    if (!state.workerId) return;
    this.dispatch(state.workerId, runId, payload);
  }

  // ── 业务级收尾 ──────────────────────────────────────────────────────

  async releaseOwner(owner: OwnerKey): Promise<void> {
    const workers = this.pool.listByOwner(owner);
    for (const worker of workers) {
      await this.stopWorker(worker.key);
    }
  }

  // ── 环境 ────────────────────────────────────────────────────────────

  async detectEnv(_runtimeHostId: string): Promise<HostCapabilityStatus> {
    // builtin Host 直接检测本机环境
    const envConfig = detectEnvConfig();
    // 过渡：返回 native 能力（builtin Host 的默认 isolation）
    return {
      native: {
        available: true,
        scopes: ["workspace"],
        cli: envConfig,
      },
    };
  }

  async installCli(input: InstallCliInput): Promise<InstallCliResult> {
    // CLI 安装在 builtin Host 上由 server 侧的 CliInstaller 处理
    // 过渡：检测当前环境返回
    const envConfig = detectEnvConfig();
    return { envConfig };
  }

  // ── 工作空间文件 ────────────────────────────────────────────────────

  async listDirectory(input: ListDirectoryInput): Promise<DirectoryListing> {
    // builtin Host 直读本机文件系统
    const result = listDirectoryOnDisk(input.path);
    return { path: result.path, entries: result.entries };
  }

  async createDirectory(input: CreateDirectoryInput): Promise<void> {
    createDirectoryOnDisk(input.path);
  }

  async listFiles(input: WorkspaceFileQuery): Promise<WorkspaceFileListResponse> {
    const signal = createFsTimeoutSignal();
    const result = await listFilesDirect(input.rootPath, input.path, signal);
    return { path: result.path, list: result.list, truncated: result.truncated };
  }

  async readFile(input: ReadFileInput): Promise<WorkspaceFileReadResponse> {
    const signal = createFsTimeoutSignal();
    const result = await readFileDirect(input.rootPath, input.path, signal);
    return {
      path: result.path,
      encoding: result.encoding,
      content: result.content,
      size: result.size,
      truncated: result.truncated,
    };
  }

  async readFileDiff(input: ReadFileDiffInput): Promise<WorkspaceFileDiffResponse> {
    return readFileDiffDirect(input.rootPath, input.path);
  }

  async searchFiles(input: SearchFilesInput): Promise<WorkspaceFileSearchResponse> {
    const result = await searchFilesDirect(input.rootPath);
    return { list: result.list, truncated: result.truncated };
  }

  async listChangedFiles(input: ListChangedFilesInput): Promise<WorkspaceChangedFilesResponse> {
    return listChangedFilesDirect(input.rootPath);
  }

  // ── 观测 ────────────────────────────────────────────────────────────

  async listWorkers(): Promise<WorkerSnapshot[]> {
    return this.pool.list().map((w) => ({
      id: w.workerId,
      workerKey: w.key,
      runtimeType: w.key.split("#")[1] ?? "unknown",
      isolationScope: parseOwnerKey(w.key.split("#")[0] as OwnerKey).scope,
      ownerId: parseOwnerKey(w.key.split("#")[0] as OwnerKey).id,
      runtimeInstanceId: w.runtimeInstanceId,
      status: w.status,
      expiresAt: null,
      createdAt: new Date(w.lastSeen).toISOString(),
      updatedAt: new Date(w.lastSeen).toISOString(),
      workspaceBindings: [],
    }));
  }

  async stopWorker(key: WorkerKey): Promise<void> {
    const entry = this.pool.remove(key);
    if (!entry) return;

    this.mailbox.cleanup(entry.workerId);

    // 停止物理载体
    const isolation = key.split("#")[1] ?? "native";
    if (!isRuntimeType(isolation)) return;
    const ref: RuntimeInstanceRef = {
      runtimeType: isolation,
      ownerId: parseOwnerKey(key.split("#")[0] as OwnerKey).id,
      workerId: entry.workerId,
      runtimeInstanceId: entry.runtimeInstanceId,
      isolationScope: parseOwnerKey(key.split("#")[0] as OwnerKey).scope,
    };
    try {
      await this.resolveProvider(isolation).stop(ref);
    } catch {
      // best-effort
    }

    // 通知 upstream 名下所有 run
    for (const runId of entry.activeRuns) {
      this.upstream.notifyWorkerLost(runId, "worker stopped").catch(() => {});
    }
  }

  // ── 过渡成员 ────────────────────────────────────────────────────────

  releaseRun(runId: string): void {
    this.pool.dissociateRun(runId);
    this.runConfigs.delete(runId);
    this.states.delete(runId);
  }

  async sendRecoveryCancel(input: {
    runId: string;
    conversationId: string;
    ref: ExecutionRef;
  }): Promise<void> {
    // builtin Host 与 server 同生共死，重启后无存活 worker，空操作
  }

  async getWorkerSnapshotForAdmin(ref: ExecutionRef): Promise<WorkerSnapshot | null> {
    const workers = await this.listWorkers();
    return (
      workers.find(
        (w) => w.runtimeInstanceId === ref.runtimeInstanceId
      ) ?? null
    );
  }

  // ── worker 生命周期 ─────────────────────────────────────────────────

  /**
   * 取得（创建）worker。不变量 2：同一 WorkerKey 至多一个活跃 worker。
   */
  private async acquireWorker(
    input: SubmitRunInput,
    wKey: WorkerKey,
    runtimeTarget: RuntimeSpec,
    runConfig: RunConfig
  ): Promise<WorkerEntry> {
    // 再次检查池（可能在异步等待期间已被其他 run 创建）
    const existing = this.pool.get(wKey);
    if (existing?.status === "ready") return existing;

    const { placement } = input;
    const isolation = placement.isolation;
    if (!isRuntimeType(isolation)) {
      throw new Error(`unsupported isolation: ${isolation}`);
    }
    const startToken = randomUUID();
    const workerId = randomUUID();

    const entry: WorkerEntry = {
      workerId,
      key: wKey,
      startToken,
      status: "starting",
      runtimeInstanceId: "",
      lastSeen: Date.now(),
      cancelledRuns: new Set(),
      activeRuns: new Set(),
    };
    this.pool.put(entry);

    // 构建 worker env
    const workerEnv = this.buildWorkerEnv(
      placement,
      startToken,
      workerId,
      isolation,
      runtimeTarget,
      runConfig
    );

    const ctx: RuntimeLaunchContext = {
      runtimeType: isolation,
      ownerId: parseOwnerKey(placement.owner).id,
      workspaceId: placement.workspaceId,
      runId: input.runId,
      placement: runtimeTarget,
      workerEnv,
      expectedRuntimeInstanceId: null,
    };

    const onExit = () => {
      this.pool.remove(wKey);
      this.mailbox.cleanup(workerId);
    };

    const { runtimeInstanceId } = await this.withTimeout(
      (async () => {
        const launched = await this.resolveProvider(isolation).start(ctx, onExit);
        await this.handshakes.waitForRegister(workerId, startToken);
        return launched;
      })(),
      this.config.launchTimeoutMs,
      `worker launch timed out for worker ${workerId}`
    );

    this.pool.markReady(wKey, runtimeInstanceId);
    return this.pool.get(wKey)!;
  }

  private onAcquired(
    runId: string,
    input: SubmitRunInput,
    wKey: WorkerKey,
    entry: WorkerEntry
  ): void {
    const state = this.states.get(runId);
    if (!state) return;

    // 就绪前到达的 cancel:state.cancelled 由 command() 标记(彼时 runIndex 还没
    // 建立,pool.markCancelled 不一定落上),两处标记任一命中都转 cancelled 终态。
    if (state.cancelled || entry.cancelledRuns.delete(runId)) {
      this.pool.dissociateRun(runId);
      this.states.delete(runId);
      this.runConfigs.delete(runId);
      this.upstream.notifyRunCancelled(runId).catch(() => {});
      return;
    }

    state.workerId = entry.workerId;
    state.status = "ready";
    this.pool.associateRun(wKey, runId);

    // 通知 ExecutionRef（过渡）
    this.upstream.notifyExecutionRef(runId, {
      runtimeType: input.placement.isolation,
      runtimeInstanceId: entry.runtimeInstanceId,
    });

    // 下发首条 user_message(runConfig 已在 submitRun 存入,worker 经 getRunConfig 拉取)
    this.dispatch(entry.workerId, runId, {
      type: "user_message",
      commandId: generateId(),
      runId,
    });
  }

  private onAcquireFailed(runId: string, err: unknown): void {
    this.states.delete(runId);
    this.upstream
      .notifyRunFailed(runId, `resolve instance failed: ${String(err)}`)
      .catch(() => {});
  }

  private onWorkerReady(
    runId: string,
    entry: WorkerEntry,
    input: SubmitRunInput
  ): void {
    this.pool.associateRun(entry.key, runId);
    this.upstream.notifyExecutionRef(runId, {
      runtimeType: input.placement.isolation,
      runtimeInstanceId: entry.runtimeInstanceId,
    });
    this.dispatch(entry.workerId, runId, {
      type: "user_message",
      commandId: generateId(),
      runId,
    });
  }

  // ── 命令下发 ────────────────────────────────────────────────────────

  private dispatch(
    workerId: string,
    runId: string,
    payload: CommandPayload
  ): void {
    const seq = (this.commandSeqs.get(workerId) ?? 0) + 1;
    this.commandSeqs.set(workerId, seq);
    const message = {
      runId,
      seq,
      type: "command" as const,
      payload,
      ts: new Date().toISOString(),
    };
    this.mailbox.push(workerId, message);
    this.config.onCommandDispatched?.({
      runId,
      commandId: payload.commandId,
      commandType: payload.type,
    });
  }

  // ── worker HTTP 端点支持（供 server 侧注册路由时调用） ──────────────

  /** worker 长轮询拉取命令。 */
  pollCommands(
    workerId: string,
    query: { afterSeq?: number; waitMs?: number }
  ): Promise<{
    commands: ReturnType<CommandMailbox["pollImmediate"]>;
    queueEpoch: number;
  }> {
    const afterSeq = query.afterSeq ?? 0;
    const waitMs = query.waitMs ?? 0;
    // touch 心跳
    const entry = this.findWorkerByWorkerId(workerId);
    if (entry) this.pool.touch(entry.key);

    return this.mailbox.poll(workerId, afterSeq, waitMs).then((commands) => ({
      commands,
      queueEpoch: this.mailbox.epochFor(workerId),
    }));
  }

  /** worker 拉取 run config。 */
  getRunConfig(runId: string): RunConfig | undefined {
    return this.runConfigs.get(runId);
  }

  /** worker 注册握手。 */
  registerWorker(
    workerId: string,
    token: string,
    info: { pid?: number }
  ): boolean {
    return this.handshakes.registerWorker(workerId, token, info);
  }

  /**
   * 校验 worker token（worker HTTP 端点鉴权用）。
   * 在 pool 中按 workerId 查找，比对其 startToken。
   */
  validateWorkerToken(workerId: string, token: string): boolean {
    const entry = this.findWorkerByWorkerId(workerId);
    return !!entry && entry.startToken === token;
  }

  /**
   * worker 上报上行事件（POST /worker/runs/:runId/events）。
   * 解析 JSON-RPC notification / command-result，逐条转发给 upstream。
   * 事件上报本身也是 worker 活着的证据，顺带 touch 心跳。
   */
  async postEvent(runId: string, body: unknown): Promise<{ ok: boolean }> {
    const events = parseWorkerEventPostBody(body, runId);
    if (!events || events.length === 0) {
      throw new Error("Invalid worker event body");
    }
    if (events.some((event) => event.runId !== runId)) {
      throw new Error("Worker event runId mismatch");
    }
    // touch worker 心跳
    const entry = this.pool.getByRunId(runId);
    if (entry) this.pool.touch(entry.key);
    for (const event of events) {
      await this.upstream.emit(runId, event);
    }
    return { ok: true };
  }

  // ── placement → 执行机细节派生 ──────────────────────────────────────

  private resolveSpec(placement: RunPlacement): RuntimeSpec {
    const isolation = placement.isolation;
    if (!isRuntimeType(isolation)) {
      throw new Error(`unsupported isolation: ${isolation}`);
    }
    const base = {
      userId: placement.userId,
      workspaceId: placement.workspaceId,
      workspaceRootPath: placement.workspacePath,
      userWorkspaceRootPath: this.config.getUserWorkspace(placement.username),
      runtimeLogHostPath: this.config.runtimeLogDir,
    };
    if (isolation === "native") {
      return resolveRuntimeSpec({ ...base, runtimeType: "native" });
    }
    return resolveRuntimeSpec({
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
    const logPaths = this.makeLogPaths(placement, conversationId);

    // native 的 CLI 路径由 Host 侧合成(override > detected);container 不走此链路
    // (镜像固定路径,经 env 注入)。
    let cliPaths: {
      claude: string | null;
      codex: string | null;
      opencode: string | null;
    } | null = null;
    if (placement.runtimeType === "native" && this.config.resolveCliPaths) {
      cliPaths = await this.config.resolveCliPaths();
    }

    return {
      runId,
      conversationId,
      workspaceId: input.placement.workspaceId,
      runtimePath: placement.runtimePath,
      env: {},
      input: input.input,
      agentProviderConfig,
      agentEventTrace: this.buildTraceConfig(
        runId,
        conversationId,
        input.placement.workspaceId,
        agentProviderConfig.agentType,
        logPaths
      ),
      workerLogFilePath: logPaths.workerRuntimeFilePath,
      ...(cliPaths?.claude ? { claudeExecutablePath: cliPaths.claude } : {}),
      ...(cliPaths?.codex ? { codexExecutablePath: cliPaths.codex } : {}),
      ...(cliPaths?.opencode
        ? { opencodeExecutablePath: cliPaths.opencode }
        : {}),
    };
  }

  private makeLogPaths(placement: RuntimeSpec, conversationId: string) {
    const logDir = this.config.runtimeLogDir;
    const fileName = conversationId.replace(/[^a-zA-Z0-9-]/g, "_");
    const runtimeLogDir = placement.runtimeLogDir;
    return {
      logDir,
      rawFilePath: join(logDir, `${fileName}.raw.jsonl`),
      rawRuntimeFilePath: posix.join(runtimeLogDir, `${fileName}.raw.jsonl`),
      aguiFilePath: join(logDir, `${fileName}.agui.jsonl`),
      aguiRuntimeFilePath: posix.join(runtimeLogDir, `${fileName}.agui.jsonl`),
      workerRuntimeFilePath: posix.join(runtimeLogDir, `${fileName}.worker.log`),
    };
  }

  private buildTraceConfig(
    runId: string,
    conversationId: string,
    workspaceId: string,
    agentType: string,
    paths: ReturnType<RuntimeHost["makeLogPaths"]>
  ): AgentEventTraceConfig {
    const enabled = this.config.agentEventTrace.enabled;
    return {
      enabled,
      logDir: enabled ? paths.logDir : undefined,
      rawFilePath: enabled ? paths.rawFilePath : undefined,
      rawRuntimeFilePath: enabled ? paths.rawRuntimeFilePath : undefined,
      aguiFilePath: enabled ? paths.aguiFilePath : undefined,
      aguiRuntimeFilePath: enabled ? paths.aguiRuntimeFilePath : undefined,
      maxFileMb: this.config.agentEventTrace.maxFileMb,
      runId,
      conversationId,
      workspaceId,
      agentType,
    };
  }

  private buildWorkerEnv(
    placement: RunPlacement,
    startToken: string,
    workerId: string,
    isolation: string,
    runtimeTarget: RuntimeSpec,
    runConfig: RunConfig
  ): Record<string, string> {
    const env: Record<string, string> = {
      AGEWORK_WORKER_ROLE: "worker",
      AGEWORK_WORKER_OWNER_ID: parseOwnerKey(placement.owner).id,
      AGEWORK_WORKER_ID: workerId,
      AGEWORK_WORKER_START_TOKEN: startToken,
      AGEWORK_WORKER_RUNTIME_TYPE: isolation,
      AGEWORK_WORKER_ISOLATION_SCOPE: placement.scope,
      AGEWORK_WORKER_WORKSPACE_PATH: runtimeTarget.runtimePath,
    };
    if (runConfig.workerLogFilePath) {
      env.AGEWORK_WORKER_LOG_FILE = runConfig.workerLogFilePath;
    }
    // Phase 2: worker 数据面对端从 server 切到 Host。
    // provider（native / sandbox）会用 RuntimeConfig.serverBaseUrl 覆盖此值——
    // 因此 providerConfig.serverBaseUrl 也必须设为 Host 的 worker HTTP 端点。
    if (this.config.workerApiBaseUrl) {
      env.AGEWORK_WORKER_API_BASE = this.config.workerApiBaseUrl;
    }
    return env;
  }

  // ── 工具 ────────────────────────────────────────────────────────────

  private findWorkerByWorkerId(workerId: string): WorkerEntry | undefined {
    return this.pool.list().find((w) => w.workerId === workerId);
  }

  private withTimeout<T>(
    promise: Promise<T>,
    ms: number,
    message: string
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(message)), ms);
      timer.unref?.();
      promise.then(
        (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        }
      );
    });
  }

  /** 进程退出时清理。 */
  drain(): void {
    this.mailbox.drain();
    if (this.fenceTimer) clearInterval(this.fenceTimer);
  }

  /**
   * 心跳判死扫描：pool 中 lastSeen 超过 heartbeatTimeoutMs 的 worker 判死。
   * 判死即从 pool 移除、清理信箱、通知 upstream 其名下所有 run。
   */
  private sweepFence(): void {
    const now = Date.now();
    const timeoutMs = this.config.heartbeatTimeoutMs;
    const workers = this.pool.list();
    for (const worker of workers) {
      if (worker.status !== "ready") continue;
      if (now - worker.lastSeen < timeoutMs) continue;
      // 通知 upstream 名下所有 run
      for (const runId of worker.activeRuns) {
        this.upstream
          .notifyWorkerLost(runId, "worker heartbeat timeout (fence)")
          .catch(() => {});
      }
      // 从 pool 移除、清理信箱
      this.pool.remove(worker.key);
      this.mailbox.cleanup(worker.workerId);
      // best-effort 停物理载体
      const isolation = worker.key.split("#")[1] ?? "native";
      if (isRuntimeType(isolation)) {
        const ref: RuntimeInstanceRef = {
          runtimeType: isolation,
          ownerId: parseOwnerKey(worker.key.split("#")[0] as OwnerKey).id,
          workerId: worker.workerId,
          runtimeInstanceId: worker.runtimeInstanceId,
          isolationScope: parseOwnerKey(worker.key.split("#")[0] as OwnerKey).scope,
        };
        Promise.resolve(this.resolveProvider(isolation).stop(ref)).catch(() => {});
      }
    }
  }
}

// ── worker 事件解析（复用 shared protocol 类型守卫） ──────────────────

/** 剥离值为 undefined 的 key，使联合类型守卫按真实字段判断。 */
function stripUndefinedKeys(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value)) {
    if (val !== undefined) result[key] = val;
  }
  return result;
}

/**
 * 解析 worker POST /worker/runs/:runId/events 的 body。
 * body 是单条或数组形式的 JSON-RPC notification / command-result。
 * 收编自 apps/server/src/worker-manager/connection/worker-event.parser.ts。
 */
function parseWorkerEventPostBody(
  body: unknown,
  routeRunId?: string
): RunChannelMessage[] | undefined {
  if (Array.isArray(body)) {
    if (body.length === 0) return undefined;
    const events: RunChannelMessage[] = [];
    for (const message of body) {
      const normalized = parseWorkerEventPostItem(message, routeRunId);
      if (!normalized) return undefined;
      events.push(normalized);
    }
    return events;
  }
  const event = parseWorkerEventPostItem(body, routeRunId);
  return event ? [event] : undefined;
}

function parseWorkerEventPostItem(
  rawBody: unknown,
  routeRunId?: string
): RunChannelMessage | undefined {
  const body = stripUndefinedKeys(rawBody);
  if (isWorkerEventRpcNotification(body)) {
    return rpcNotificationToUpstreamMessage(body);
  }
  if (isWorkerCommandResultRpcResponse(body)) {
    return rpcResponseToCommandResultMessage(body, { runId: routeRunId });
  }
  return undefined;
}
