import { randomUUID } from "node:crypto";
import type {
  CommandPayload,
  CreateDirectoryInput,
  DirectoryListing,
  HostCapabilityStatus,
  InstallCliInput,
  InstallCliResult,
  ListChangedFilesInput,
  ListDirectoryInput,
  OwnerKey,
  ReadFileDiffInput,
  ReadFileInput,
  ReleaseOwnerInput,
  RunChannelMessage,
  RunConfig,
  RuntimeHostContract,
  RuntimeHostCommandInput,
  RuntimeHostRunRef,
  RuntimeHostUpstream,
  RuntimeSpec,
  SearchFilesInput,
  StopWorkerInput,
  SubmitRunInput,
  WorkerKey,
  WorkerSnapshot,
  WorkspaceFileQuery,
} from "@agework/shared/protocol";
import { generateId } from "@agework/shared";
import { parseOwnerKey, workerKey } from "@agework/shared/protocol";
import type {
  WorkspaceChangedFilesResponse,
  WorkspaceFileDiffResponse,
  WorkspaceFileListResponse,
  WorkspaceFileReadResponse,
  WorkspaceFileSearchResponse,
} from "@agework/shared/api";
import {
  createRuntimeResolver,
  isRuntimeType,
  type RuntimeConfig,
  type RuntimeInstanceRef,
  type RuntimeLaunchContext,
  type RuntimeProvider,
  type RuntimeType,
} from "@agework/providers";
import {
  isWorkerCommandResultRpcResponse,
  isWorkerEventRpcNotification,
  rpcNotificationToUpstreamMessage,
  rpcResponseToCommandResultMessage,
} from "@agework/shared/protocol/rpc";
export { WorkerHttpServer } from "./worker-http-server.js";
import { WorkerPool, type WorkerEntry } from "./worker-pool";
import { buildWorkerEnv, makeRunConfig, resolveSpec } from "./run-config";
import { CommandMailbox } from "./command-mailbox";
import { HandshakeStore } from "./handshake-store";
import { RunSessionRegistry } from "./run-session-registry";
import {
  HostEnvironmentOperations,
  HostWorkspaceOperations,
} from "./host-operations";

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
  /** agent CLI 一键安装的根目录(per-agent 一个子目录,不占系统全局 npm)。 */
  cliInstallDir: string;
  /** 这台 Host 支持的 runtimeType 能力矩阵。 */
  capabilities: HostCapabilityStatus;
  /** Runtime provider 配置（传给 @agework/providers）。 */
  providerConfig: RuntimeConfig;
  /**
   * worker 回连 Host 的 HTTP 基地址（如 `http://0.0.0.0:7101/api/v1`）。
   * worker 的 AGEWORK_WORKER_API_BASE 设为此值；builtin 与 registered 都由各自 Host 承接数据面。
   */
  workerApiBaseUrl?: string;
  /**
   * native runtimeType 的 agent CLI 路径解析（override > detected）。Host 是执行机器本机,
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

type WorkerRemovalMode = "release" | "exited";

type WorkerLaunchAttempt = {
  cancelled: boolean;
  runtimeInstanceId?: string;
  cleanupPromise?: Promise<void>;
};

/**
 * RuntimeHost：部署在一台执行机器上的常驻执行节点。
 *
 * 实现 `RuntimeHostContract`，作为 Host 门面协调 WorkerPool、RunSessionRegistry、
 * CommandMailbox、HandshakeStore 和本机操作组件。一台机器 = 一个 Host =
 * 一行注册 = 一条隧道。
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
  private readonly sessions = new RunSessionRegistry();
  private readonly workspaceOperations = new HostWorkspaceOperations();
  private readonly environmentOperations: HostEnvironmentOperations;
  private readonly fenceTimer: ReturnType<typeof setInterval> | undefined;
  private upstream!: RuntimeHostUpstream;
  private readonly resolveProvider: (type: RuntimeType) => RuntimeProvider;
  // 不用 constructor parameter property:server dev 以 Node strip-only TS
  // 直接加载本文件,strip-only 不支持 parameter property 语法。
  private readonly config: RuntimeHostConfig;

  constructor(config: RuntimeHostConfig) {
    this.config = config;
    this.resolveProvider = createRuntimeResolver(config.providerConfig);
    this.environmentOperations = new HostEnvironmentOperations(
      config.capabilities,
      config.cliInstallDir
    );
    // 心跳判死定时器：定期扫描 pool，超时未见心跳即判死。
    const interval = Math.max(1000, Math.floor(config.heartbeatTimeoutMs / 3));
    this.fenceTimer = setInterval(() => this.sweepFence(), interval);
    this.fenceTimer.unref?.();
  }

  setUpstream(upstream: RuntimeHostUpstream): void {
    this.upstream = upstream;
  }

  // ── 执行 ────────────────────────────────────────────────────────────

  submitRun(input: SubmitRunInput): Promise<void> {
    const { runId } = input;
    if (this.sessions.has(runId)) return Promise.resolve();

    const inFlight = this.sessions.getSubmission(runId);
    if (inFlight) return inFlight;

    // 在任何 RunConfig/CLI I/O 前占位：timeout/cancel/release 必须从提交第一刻
    // 就能命中 run，不能等异步配置完成后才建立生命周期状态。
    this.sessions.reserve(runId);
    const submission = Promise.resolve()
      .then(() => this.acceptRun(input))
      .catch((err) => {
        this.clearRunState(runId);
        throw err;
      });
    return this.sessions.trackSubmission(runId, submission);
  }

  private async acceptRun(input: SubmitRunInput): Promise<void> {
    const { runId, placement } = input;

    // spec/config 组装失败同步抛出(配置/入参问题),由调用方按启动失败处理。
    // 每次 run 都建 RunConfig(不只新建 worker 时)——复用已有 worker 的 run
    // 同样要能被 worker 经 getRunConfig 拉到自己的配置。
    const runtimeTarget = resolveSpec(this.config, placement);
    const runConfig = await makeRunConfig(this.config, input, runtimeTarget);
    if (!this.sessions.has(runId)) return; // releaseRun 已先赢得竞态，不再启动执行资源
    this.sessions.setConfig(runId, runConfig);

    const wKey = workerKey(placement.owner, placement.runtimeType);
    const existing = this.pool.get(wKey);

    if (existing?.status === "ready") {
      this.onAcquired(runId, wKey, existing);
      return;
    }

    // 异步取得 worker——受理即返回
    this.acquireWorkerOnce(input, wKey, runtimeTarget, runConfig).then(
      (entry) => this.onAcquired(runId, wKey, entry),
      (err) => this.onAcquireFailed(runId, err)
    );
  }

  async command(input: RuntimeHostCommandInput): Promise<void> {
    const { payload } = input;
    const { runId } = payload;
    if (!this.sessions.has(runId)) return;

    if (payload.type === "cancel" && !this.sessions.isReady(runId)) {
      // 就绪前 cancel：标记，就绪时转 cancelled
      const wKey = this.pool.getByRunId(runId)?.key;
      if (wKey) this.pool.markCancelled(wKey, runId);
      this.sessions.markCancelled(runId);
      return;
    }

    const workerId = this.sessions.workerId(runId);
    if (!workerId) return;
    this.dispatch(workerId, runId, payload);
  }

  // ── 业务级收尾 ──────────────────────────────────────────────────────

  async releaseOwner(input: ReleaseOwnerInput): Promise<void> {
    const workers = this.pool.listByOwner(input.owner);
    for (const worker of workers) {
      await this.removeWorkerByKey(
        worker.key,
        "worker owner released",
        "release"
      );
    }
  }

  // ── 环境 ────────────────────────────────────────────────────────────

  async detectEnv(_runtimeHostId: string): Promise<HostCapabilityStatus> {
    return this.environmentOperations.detectEnv();
  }

  async installCli(input: InstallCliInput): Promise<InstallCliResult> {
    return this.environmentOperations.installCli(input);
  }

  // ── 工作空间文件 ────────────────────────────────────────────────────

  async listDirectory(input: ListDirectoryInput): Promise<DirectoryListing> {
    return this.workspaceOperations.listDirectory(input);
  }

  async createDirectory(input: CreateDirectoryInput): Promise<void> {
    this.workspaceOperations.createDirectory(input);
  }

  async listFiles(
    input: WorkspaceFileQuery
  ): Promise<WorkspaceFileListResponse> {
    return this.workspaceOperations.listFiles(input);
  }

  async readFile(input: ReadFileInput): Promise<WorkspaceFileReadResponse> {
    return this.workspaceOperations.readFile(input);
  }

  async readFileDiff(
    input: ReadFileDiffInput
  ): Promise<WorkspaceFileDiffResponse> {
    return this.workspaceOperations.readFileDiff(input);
  }

  async searchFiles(
    input: SearchFilesInput
  ): Promise<WorkspaceFileSearchResponse> {
    return this.workspaceOperations.searchFiles(input);
  }

  async listChangedFiles(
    input: ListChangedFilesInput
  ): Promise<WorkspaceChangedFilesResponse> {
    return this.workspaceOperations.listChangedFiles(input);
  }

  // ── 观测 ────────────────────────────────────────────────────────────

  async listWorkers(): Promise<WorkerSnapshot[]> {
    // 内存池条目(WorkerEntry)的直投影;runtimeHostId 由 server 路由层盖章
    return this.pool.list().map((w) => {
      const owner = parseOwnerKey(w.key.split("#")[0] as OwnerKey);
      return {
        runtimeHostId: "",
        workerId: w.workerId,
        workerKey: w.key,
        runtimeType: w.key.split("#")[1] ?? "unknown",
        scope: owner.scope,
        ownerId: owner.id,
        runIds: [...w.activeRuns],
        runtimeInstanceId: w.runtimeInstanceId,
        status: w.status,
        lastSeenAt: new Date(w.lastSeen).toISOString(),
      };
    });
  }

  async stopWorker(input: StopWorkerInput): Promise<void> {
    await this.removeWorkerByKey(input.key, "worker stopped", "release");
  }

  /** worker 消失的唯一收尾路径：清索引、终结 run，再收资源。 */
  private async removeWorkerByKey(
    key: WorkerKey,
    reason: string,
    mode: WorkerRemovalMode,
    expectedWorkerId?: string
  ): Promise<void> {
    const entry = this.pool.remove(key, expectedWorkerId);
    if (!entry) return;

    this.handshakes.cancel(entry.workerId, reason);
    this.mailbox.cleanup(entry.workerId);

    // 先收口 Host 内的 run 状态，终态不依赖 provider 收资源成功。
    for (const runId of entry.activeRuns) {
      this.clearRunState(runId);
      this.upstream.notifyWorkerLost(runId, reason).catch(() => {});
    }

    if (mode === "exited" || !entry.runtimeInstanceId) return;

    const runtimeType = key.split("#")[1] ?? "native";
    if (!isRuntimeType(runtimeType)) return;
    const ref = this.makeRuntimeInstanceRef(key, entry, runtimeType);
    try {
      await this.resolveProvider(runtimeType).release(ref);
    } catch {
      // best-effort
    }
  }

  releaseRun(input: RuntimeHostRunRef): void {
    this.clearRunState(input.runId);
  }

  // ── worker 生命周期 ─────────────────────────────────────────────────

  /**
   * 取得（创建）worker。不变量 2：同一 WorkerKey 至多一个活跃 worker。
   */
  private acquireWorkerOnce(
    input: SubmitRunInput,
    wKey: WorkerKey,
    runtimeTarget: RuntimeSpec,
    runConfig: RunConfig
  ): Promise<WorkerEntry> {
    return this.pool.acquireOnce(wKey, () =>
      this.acquireWorker(input, wKey, runtimeTarget, runConfig)
    );
  }

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
    const runtimeType = placement.runtimeType;
    if (!isRuntimeType(runtimeType)) {
      throw new Error(`unsupported runtimeType: ${runtimeType}`);
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

    // 先挂握手再启动资源，避免极快 worker 回连时 pending 尚未建立。
    const handshake = this.handshakes.waitForRegister(workerId, startToken);
    const provider = this.resolveProvider(runtimeType);
    const attempt: WorkerLaunchAttempt = { cancelled: false };

    // 构建 worker env
    const workerEnv = buildWorkerEnv(
      this.config,
      placement,
      startToken,
      workerId,
      runtimeType,
      runtimeTarget,
      runConfig
    );

    const ctx: RuntimeLaunchContext = {
      runtimeType,
      ownerId: parseOwnerKey(placement.owner).id,
      workspaceId: placement.workspaceId,
      runId: input.runId,
      placement: runtimeTarget,
      workerEnv,
      expectedRuntimeInstanceId: null,
    };

    const onExit = () => {
      void this.removeWorkerByKey(
        wKey,
        "worker exited unexpectedly",
        "exited",
        workerId
      );
    };

    try {
      const { runtimeInstanceId } = await this.withTimeout(
        (async () => {
          const launched = await provider.start(ctx, onExit, (instanceId) => {
            attempt.runtimeInstanceId = instanceId;
            entry.runtimeInstanceId = instanceId;
            if (attempt.cancelled) {
              void this.cleanupFailedLaunch(
                provider,
                parseOwnerKey(placement.owner),
                entry,
                attempt
              );
            }
          });
          attempt.runtimeInstanceId ??= launched.runtimeInstanceId;
          entry.runtimeInstanceId = launched.runtimeInstanceId;
          if (attempt.cancelled) {
            await this.cleanupFailedLaunch(
              provider,
              parseOwnerKey(placement.owner),
              entry,
              attempt
            );
            throw new Error(`worker launch cancelled for worker ${workerId}`);
          }
          await handshake;
          return launched;
        })(),
        this.config.launchTimeoutMs,
        `worker launch timed out for worker ${workerId}`
      );

      this.pool.markReady(wKey, runtimeInstanceId);
      const current = this.pool.get(wKey);
      if (!current || current.workerId !== workerId) {
        throw new Error(`worker launch superseded for worker ${workerId}`);
      }
      return current;
    } catch (err) {
      attempt.cancelled = true;
      this.handshakes.cancel(workerId, String(err));
      await handshake.catch(() => {});
      this.pool.remove(wKey, workerId);
      this.mailbox.cleanup(workerId);
      await this.cleanupFailedLaunch(
        provider,
        parseOwnerKey(placement.owner),
        entry,
        attempt
      );
      throw err;
    }
  }

  private onAcquired(runId: string, wKey: WorkerKey, entry: WorkerEntry): void {
    if (!this.sessions.has(runId)) return;

    // 就绪前到达的 cancel:state.cancelled 由 command() 标记(彼时 runIndex 还没
    // 建立,pool.markCancelled 不一定落上),两处标记任一命中都转 cancelled 终态。
    if (this.sessions.isCancelled(runId) || entry.cancelledRuns.delete(runId)) {
      this.pool.dissociateRun(runId);
      this.sessions.delete(runId);
      this.upstream.notifyRunCancelled(runId).catch(() => {});
      return;
    }

    this.sessions.bindWorker(runId, entry.workerId);
    this.pool.associateRun(wKey, runId);

    // 下发首条 user_message(runConfig 已在 submitRun 存入,worker 经 getRunConfig 拉取)
    this.dispatch(entry.workerId, runId, {
      type: "user_message",
      commandId: generateId(),
      runId,
    });
  }

  private onAcquireFailed(runId: string, err: unknown): void {
    this.clearRunState(runId);
    this.upstream
      .notifyRunFailed(runId, `resolve instance failed: ${String(err)}`)
      .catch(() => {});
  }

  // ── 命令下发 ────────────────────────────────────────────────────────

  private dispatch(
    workerId: string,
    runId: string,
    payload: CommandPayload
  ): void {
    this.mailbox.enqueue(workerId, runId, payload);
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
  getRunConfig(workerId: string, runId: string): RunConfig | undefined {
    if (!this.pool.ownsRun(workerId, runId)) return undefined;
    return this.sessions.getConfig(runId);
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
  async postEvent(
    workerId: string,
    runId: string,
    body: unknown
  ): Promise<{ ok: boolean }> {
    if (!this.pool.ownsRun(workerId, runId)) {
      throw new Error(`Worker ${workerId} does not own run ${runId}`);
    }
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

  // ── 工具 ────────────────────────────────────────────────────────────

  private findWorkerByWorkerId(workerId: string): WorkerEntry | undefined {
    return this.pool.list().find((w) => w.workerId === workerId);
  }

  private clearRunState(runId: string): void {
    this.pool.dissociateRun(runId);
    this.sessions.delete(runId);
  }

  private makeRuntimeInstanceRef(
    key: WorkerKey,
    entry: WorkerEntry,
    runtimeType: RuntimeType
  ): RuntimeInstanceRef {
    const owner = parseOwnerKey(key.split("#")[0] as OwnerKey);
    return {
      runtimeType,
      ownerId: owner.id,
      workerId: entry.workerId,
      runtimeInstanceId: entry.runtimeInstanceId,
      scope: owner.scope,
    };
  }

  private async cleanupFailedLaunch(
    provider: RuntimeProvider,
    owner: ReturnType<typeof parseOwnerKey>,
    entry: WorkerEntry,
    attempt: WorkerLaunchAttempt
  ): Promise<void> {
    if (!attempt.runtimeInstanceId) return;
    attempt.cleanupPromise ??= Promise.resolve(
      provider.destroy({
        runtimeType: provider.type,
        ownerId: owner.id,
        workerId: entry.workerId,
        runtimeInstanceId: attempt.runtimeInstanceId,
        scope: owner.scope,
      })
    ).catch(() => {});
    await attempt.cleanupPromise;
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
   * 判死走与 stopWorker 相同的收尾(出池、清信箱、通知名下 run、停运行实例)。
   */
  private sweepFence(): void {
    const now = Date.now();
    const timeoutMs = this.config.heartbeatTimeoutMs;
    for (const worker of this.pool.list()) {
      if (worker.status !== "ready") continue;
      if (now - worker.lastSeen < timeoutMs) continue;
      // removeWorkerByKey 内部吞掉运行实例停止失败,不会 reject
      void this.removeWorkerByKey(
        worker.key,
        "worker heartbeat timeout (fence)",
        "release"
      );
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
