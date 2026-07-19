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
  ReadFileDiffInput,
  ReadFileInput,
  ReleaseRuntimeResourcesInput,
  RuntimeLifecycleClaim,
  RuntimeLifecycleTarget,
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
  WorkerSnapshot,
  WorkspaceFileQuery,
} from "@agework/shared/protocol";
import { generateId } from "@agework/shared";
import type {
  WorkspaceChangedFilesResponse,
  WorkspaceFileDiffResponse,
  WorkspaceFileListResponse,
  WorkspaceFileReadResponse,
  WorkspaceFileSearchResponse,
} from "@agework/shared/api";
import {
  isRuntimeType,
  type RuntimeInstanceRef,
  type RuntimeLaunchContext,
  type RuntimeProvider,
  type RuntimeProviderPlugin,
  type RuntimeType,
} from "@agework/runtime-sdk";
import { createRuntimeResolver } from "../providers/registry";
import type { RuntimeHostProviderConfig } from "../providers/types";
import {
  isWorkerCommandResultRpcResponse,
  isWorkerEventRpcNotification,
  rpcNotificationToUpstreamMessage,
  rpcResponseToCommandResultMessage,
} from "@agework/shared/protocol/rpc";
export { WorkerHttpServer } from "./worker-http-server.js";
export { loadRuntimePlugins } from "../plugins/runtime-plugin-loader.js";
import {
  WorkerPool,
  type WorkerEntry,
  deriveReuseIdentity,
  type AcquisitionTask,
  type ReuseIdentity,
} from "./worker-pool";
import {
  CleanupLedger,
  type CleanupMetadata,
  type ReleaseCleanupContext,
} from "./cleanup-ledger";
import { buildWorkerEnv, makeRunConfig, resolveSpec } from "./run-config";
import { CommandMailbox } from "./command-mailbox";
import { HandshakeStore } from "./handshake-store";
import { RunSessionRegistry } from "./run-session-registry";
import {
  HostEnvironmentOperations,
  HostWorkspaceOperations,
} from "./host-operations";
import { WorkerEventRequestError } from "./worker-event-request.error";

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
  /** 这台 Host 支持的 runtimeType 能力矩阵(启动时快照;可经 refreshCapabilities 刷新)。 */
  capabilities: HostCapabilityStatus;
  /**
   * 能力矩阵动态刷新钩子:返回最新矩阵(如重探 docker daemon)。提供后 Host
   * 定期刷新,放置准入按当前矩阵判断——依赖的 daemon 中途挂掉只拦新 run。
   * 刷新失败保留上一次矩阵(best-effort)。
   */
  refreshCapabilities?: () => Promise<HostCapabilityStatus>;
  /** 能力矩阵刷新间隔(ms),默认 60s。 */
  capabilityRefreshMs?: number;
  /** Runtime Host 的内建 provider 配置；插件只接收其中的通用部分。 */
  providerConfig: RuntimeHostProviderConfig;
  /** 按需装配的 runtime provider；只有 Native 由核心包内建。 */
  providerPlugins?: RuntimeProviderPlugin[];
  /** Worker runner 显式加载的外部 Agent plugin 包；内置 adapters 不在此列。 */
  agentPluginPackages?: string[];
  /**
   * native runtimeType 的 agent CLI 路径解析（override > detected）。Host 是执行机器本机,
   * 由宿主注入:builtin 用 server 的 RuntimeService 解析,daemon 用本机 detectEnvConfig。
   * 未提供时 RunConfig 不带 CLI 路径,worker 退回 PATH 查找。
   */
  resolveCliPaths?: () => Promise<{
    claude: string | null;
    codex: string | null;
    opencode: string | null;
    pi: string | null;
  }>;
  /** 命令下发审计钩子(builtin 场景由 server 接到 run-event 账本;daemon 场景不设)。 */
  onCommandDispatched?: (info: {
    runId: string;
    commandId: string;
    commandType: string;
  }) => void;
}

export type { RuntimeHostProviderConfig } from "../providers/types";

type WorkerRemovalMode = "release" | "exited";

type WorkerLaunchAttempt = {
  cancelled: boolean;
  cancelReason?: Error;
  release?: ReleaseCleanupContext;
  runtimeInstanceId?: string;
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
  private readonly capabilityTimer: ReturnType<typeof setInterval> | undefined;
  private upstream!: RuntimeHostUpstream;
  private readonly resolveProvider: (type: RuntimeType) => RuntimeProvider;
  // 不用 constructor parameter property:server dev 以 Node strip-only TS
  // 直接加载本文件,strip-only 不支持 parameter property 语法。
  private readonly config: RuntimeHostConfig;
  /** 当前能力矩阵:启动为配置快照,提供刷新钩子时定期覆盖。放置准入读这里。 */
  private capabilities: HostCapabilityStatus;
  /** 每个 user 的撤销 version 高水位。 */
  private readonly revokedThroughVersions = new Map<string, number>();
  /** 每个 user 已观察到的最高 version。 */
  private readonly maxObservedVersions = new Map<string, number>();
  /** workspace 永久 tombstone:已释放的 workspaceId 不再接受新 submit。 */
  private readonly deletedWorkspaceIds = new Set<string>();
  /** provider 资源的 write-ahead、singleflight 清理账本。 */
  private readonly cleanupLedger = new CleanupLedger();
  /** shutdown promise(并发 SIGINT/SIGTERM 安全:重复信号返回同一 promise)。 */
  private shutdownPromise: Promise<void> | undefined;

  constructor(config: RuntimeHostConfig) {
    this.config = config;
    this.capabilities = config.capabilities;
    this.resolveProvider = createRuntimeResolver(
      config.providerConfig,
      config.providerPlugins,
      Object.keys(config.capabilities)
    );
    this.environmentOperations = new HostEnvironmentOperations(
      () => this.capabilities,
      config.cliInstallDir
    );
    // 心跳判死定时器：定期扫描 pool，超时未见心跳即判死。
    const interval = Math.max(1000, Math.floor(config.heartbeatTimeoutMs / 3));
    this.fenceTimer = setInterval(
      () => void this.sweepFence().catch(() => {}),
      interval
    );
    this.fenceTimer.unref?.();
    // 能力矩阵刷新：依赖的 daemon(如 docker)中途挂掉/恢复要反映到放置准入。
    const refresh = config.refreshCapabilities;
    if (refresh) {
      this.capabilityTimer = setInterval(() => {
        refresh().then(
          (next) => {
            this.capabilities = next;
          },
          () => {
            // 刷新失败保留上一次矩阵(best-effort)
          }
        );
      }, config.capabilityRefreshMs ?? 60_000);
      this.capabilityTimer.unref?.();
    }
  }

  /** 当前能力矩阵(register 上报 / 观测用)。 */
  getCapabilities(): HostCapabilityStatus {
    return this.capabilities;
  }

  setUpstream(upstream: RuntimeHostUpstream): void {
    this.upstream = upstream;
  }

  // ── 执行 ────────────────────────────────────────────────────────────

  submitRun(input: SubmitRunInput): Promise<void> {
    const { runId, placement } = input;
    if (this.sessions.has(runId)) return Promise.resolve();

    const inFlight = this.sessions.getSubmission(runId);
    if (inFlight) return inFlight;

    // workspace tombstone:已释放的 workspace 不再接受新 submit
    if (this.deletedWorkspaceIds.has(placement.workspaceId)) {
      return Promise.reject(
        new Error(
          `run ${runId} rejected: workspace ${placement.workspaceId} has been released (tombstone)`
        )
      );
    }

    // 在任何 RunConfig/CLI I/O 前占位：timeout/cancel/release 必须从提交第一刻
    // 就能命中 run，不能等异步配置完成后才建立生命周期状态。
    this.sessions.reserve(runId, {
      userId: placement.userId,
      workspaceId: placement.workspaceId,
      scope: placement.scope,
      runtimeType: placement.runtimeType,
      userLifecycleVersion: placement.userLifecycleVersion,
    });

    // generation fence:submit 的准入条件是 version > revokedThroughVersion
    // && version >= maxObservedVersion
    if (!this.admitSubmission(placement.userId, placement.userLifecycleVersion)) {
      this.sessions.delete(runId);
      return Promise.reject(
        new Error(
          `run ${runId} rejected: user ${placement.userId} lifecycle version ${placement.userLifecycleVersion} is fenced`
        )
      );
    }

    const submission = Promise.resolve()
      .then(() => this.acceptRun(input))
      .catch((err) => {
        this.clearRunState(runId);
        throw err;
      });
    return this.sessions.trackSubmission(runId, submission);
  }

  /** 检查 submission 是否通过 generation fence。 */
  private admitSubmission(userId: string, version: number): boolean {
    const revoked = this.revokedThroughVersions.get(userId) ?? 0;
    if (version <= revoked) return false;
    const maxObserved = this.maxObservedVersions.get(userId) ?? 0;
    if (version < maxObserved) return false;
    // 接受后同步提升 maxObservedVersion
    this.maxObservedVersions.set(userId, Math.max(maxObserved, version));
    return true;
  }

  private async acceptRun(input: SubmitRunInput): Promise<void> {
    const { runId, placement } = input;
    this.assertPlacementSupported(placement);

    this.sessions.setPhase(runId, "configuring");
    // spec/config 组装失败同步抛出(配置/入参问题),由调用方按启动失败处理。
    // 每次 run 都建 RunConfig(不只新建 worker 时)——复用已有 worker 的 run
    // 同样要能被 worker 经 getRunConfig 拉到自己的配置。
    const runtimeTarget = resolveSpec(this.config, placement);
    const runConfig = await makeRunConfig(this.config, input, runtimeTarget);
    if (!this.sessions.has(runId)) return; // releaseRun 已先赢得竞态，不再启动执行资源
    this.sessions.setConfig(runId, runConfig);

    const identity = deriveReuseIdentity(placement);
    const existing = this.pool.getByIdentity(identity, placement.userLifecycleVersion);

    if (existing?.status === "ready") {
      // 复用命中:同一 (identity, version) 的 ready worker
      existing.workspaceIds.add(placement.workspaceId);
      this.onAcquired(runId, existing.workerId, existing);
      return;
    }

    this.sessions.setPhase(runId, "acquiring");
    // 异步取得 worker——受理即返回
    this.acquireWorkerOnce(input, identity, runtimeTarget, runConfig).then(
      (entry) => this.onAcquired(runId, entry.workerId, entry),
      (err) => this.onAcquireFailed(runId, err)
    );
  }

  async command(input: RuntimeHostCommandInput): Promise<void> {
    const { payload } = input;
    const { runId } = payload;
    if (!this.sessions.has(runId)) return;

    if (payload.type === "cancel" && !this.sessions.isReady(runId)) {
      // 就绪前 cancel：标记，就绪时转 cancelled
      const entry = this.pool.getByRunId(runId);
      if (entry) this.pool.markCancelled(entry.workerId, runId);
      this.sessions.markCancelled(runId);
      return;
    }

    const workerId = this.sessions.workerId(runId);
    if (!workerId) return;
    this.dispatch(workerId, runId, payload);
  }

  private assertPlacementSupported(
    placement: SubmitRunInput["placement"]
  ): void {
    const capability = this.capabilities[placement.runtimeType];
    if (!capability?.available) {
      const reason = capability?.reason ? `: ${capability.reason}` : "";
      throw new Error(
        `runtimeType ${placement.runtimeType} is not available on this Host${reason}`
      );
    }
    if (!capability.scopes.includes(placement.scope)) {
      throw new Error(
        `runtimeType ${placement.runtimeType} does not support ${placement.scope} scope on this Host`
      );
    }
  }

  // ── 资源生命周期 ────────────────────────────────────────────────────

  async releaseResources(input: ReleaseRuntimeResourcesInput): Promise<void> {
    const { target } = input;
    // SPEC §6.3: “第一次 await 前同步 FENCED”——安装 fence/tombstone 是线性化点,
    // 必须在任何 await 前完成,确保在此之后的 submit 被拒绝。
    if (target.type === "workspace") {
      this.deletedWorkspaceIds.add(target.workspaceId);
    } else {
      const currentRevoked = this.revokedThroughVersions.get(target.userId) ?? 0;
      this.revokedThroughVersions.set(
        target.userId,
        Math.max(currentRevoked, target.userLifecycleVersion)
      );
    }

    // 重试匹配的 pending cleanup(SPEC §5.2: release 必须覆盖所有阶段)。
    // 不吞错误:如果 pending cleanup 仍然失败,传播给调用方(RPC 返回错误)。
    await this.retryPendingCleanups(target);

    if (target.type === "workspace") {
      await this.releaseWorkspaceResources(target.workspaceId);
    } else {
      await this.releaseUserResources(
        target.userId,
        target.userLifecycleVersion
      );
    }
  }

  /**
   * 重试匹配 target 的 pending cleanup(SPEC §5.2 release_pending 重放消费者)。
   *
   * releaseResources 入口先调用本方法:如果上次 release 因 provider 清理失败
   * 留下了 pending cleanup,先尝试重放。重放成功的从账本移除;仍然失败的
   * **传播错误**——不能吞:否则 RPC 返回成功 ACK 但 ledger 仍有残留(SPEC §5.2)。
   */
  private async retryPendingCleanups(
    target: ReleaseRuntimeResourcesInput["target"]
  ): Promise<void> {
    const release = this.releaseContext(target);
    await this.cleanupLedger.retry(
      (cleanup) => {
        if (cleanup.release) {
          return this.sameReleaseTarget(cleanup.release, release);
        }
        if (target.type === "workspace") {
          return (
            cleanup.scope === "workspace" &&
            cleanup.workspaceIds.includes(target.workspaceId)
          );
        }
        return (
          cleanup.userId === target.userId &&
          cleanup.userLifecycleVersion <= target.userLifecycleVersion
        );
      },
      release
    );
  }

  /**
   * workspace target:取消/fence 该 workspace 的 submission 和 run;
   * 取消并等待匹配的 acquisition settle;
   * 只释放 workspace-scope worker;user-scope 共享 worker保留;
   * 安装永久 tombstone 阻止后续 submit。
   */
  private async releaseWorkspaceResources(workspaceId: string): Promise<void> {
    // 1. 安装 tombstone(同步线性化点:在此之后的 submit 被拒绝)
    this.deletedWorkspaceIds.add(workspaceId);

    // 2. 取消该 workspace 的所有 active session
    for (const { runId, placement } of this.sessions.listSessions()) {
      if (placement.workspaceId === workspaceId) {
        this.clearRunState(runId);
        this.upstream.notifyRunCancelled(runId).catch(() => {});
      }
    }

    // 3. 取消并等待匹配的在途 acquisition settle(SPEC §6.3 ACQUISITIONS_DRAINING)
    const release: ReleaseCleanupContext = {
      target: { type: "workspace", workspaceId },
    };
    await this.pool.detachWorkspaceAcquisitions(workspaceId, release);

    // 4. 释放 workspace-scope worker;user-scope 共享 worker保留
    const workers = this.pool.listByWorkspace(workspaceId);
    for (const worker of workers) {
      if (worker.isolation.scope === "workspace") {
        // removeWorker 不再吞 provider 错误,错误会传播给调用方
        await this.removeWorker(
          worker.workerId,
          "workspace released",
          "release",
          release
        );
      }
    }
  }

  /**
   * user target:fence 该 user 中 version <= target 的 submission、acquisition 和 worker。
   * 安装 fence(SPEC §6.3 FENCED),覆盖两类 scope。
   */
  private async releaseUserResources(
    userId: string,
    userLifecycleVersion: number
  ): Promise<void> {
    // 1. 安装 fence:提升 revokedThroughVersion(同步线性化点)
    const currentRevoked = this.revokedThroughVersions.get(userId) ?? 0;
    this.revokedThroughVersions.set(
      userId,
      Math.max(currentRevoked, userLifecycleVersion)
    );

    // 2. 取消该 user 中 version <= target 的所有 active session
    for (const { runId, placement } of this.sessions.listSessions()) {
      if (
        placement.userId === userId &&
        placement.userLifecycleVersion <= userLifecycleVersion
      ) {
        this.clearRunState(runId);
        this.upstream.notifyRunCancelled(runId).catch(() => {});
      }
    }

    // 3. 取消并等待匹配的在途 acquisition settle(SPEC §6.3 ACQUISITIONS_DRAINING)
    const release: ReleaseCleanupContext = {
      target: { type: "user", userId },
      userLifecycleVersion,
    };
    await this.pool.drainAcquisitions(
      (a) =>
        a.userId === userId &&
        a.userLifecycleVersion <= userLifecycleVersion,
      release
    );

    // 4. 释放该 user 的所有 worker(覆盖两类 scope)
    const workers = this.pool.listByUser(userId);
    for (const worker of workers) {
      if (worker.userLifecycleVersion <= userLifecycleVersion) {
        await this.removeWorker(
          worker.workerId,
          "user released",
          "release",
          release
        );
      }
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

  // ── 诊断 ────────────────────────────────────────────────────────────

  /** 恢复对账清单包含尚未绑定 Worker 的 acquiring run。 */
  async listRunIds(): Promise<string[]> {
    return this.sessions.listRunIds();
  }

  async listWorkers(): Promise<WorkerSnapshot[]> {
    // 内存池条目(WorkerEntry)的直投影;runtimeHostId 由 server 路由层盖章
    return this.pool.list().map((w) => ({
      runtimeHostId: "",
      workerId: w.workerId,
      runtimeType: w.runtimeType,
      isolation: {
        scope: w.isolation.scope,
        subjectId: w.isolation.subjectId,
      },
      userId: w.userId,
      runIds: [...w.activeRuns],
      runtimeInstanceId: w.runtimeInstanceId,
      status: w.status,
      lastSeenAt: new Date(w.lastSeen).toISOString(),
    }));
  }

  /** 业务生命周期 claims 投影(重连对账用)。 */
  async listLifecycleClaims(): Promise<RuntimeLifecycleClaim[]> {
    const claims: RuntimeLifecycleClaim[] = [];
    // session claims(覆盖尚未形成 ready worker 的状态)
    for (const { runId, phase, placement } of this.sessions.listSessions()) {
      claims.push({
        kind: "session",
        runtimeHostId: "",
        runId,
        phase,
        userId: placement.userId,
        userLifecycleVersion: placement.userLifecycleVersion,
        workspaceId: placement.workspaceId,
      });
    }
    // worker claims
    for (const w of this.pool.list()) {
      claims.push({
        kind: "worker",
        runtimeHostId: "",
        workerId: w.workerId,
        scope: w.isolation.scope,
        subjectId: w.isolation.subjectId,
        userId: w.userId,
        userLifecycleVersion: w.userLifecycleVersion,
        workspaceIds: [...w.workspaceIds],
      });
    }
    // release_pending claims(provider 清理失败的重试账本)
    for (const cleanup of this.cleanupLedger.list()) {
      if (!cleanup.release) continue;
      if (cleanup.release.target.type === "workspace") {
        claims.push({
          kind: "release_pending",
          runtimeHostId: "",
          target: cleanup.release.target,
        });
      } else {
        const userLifecycleVersion =
          "userLifecycleVersion" in cleanup.release
            ? cleanup.release.userLifecycleVersion
            : undefined;
        claims.push({
          kind: "release_pending",
          runtimeHostId: "",
          target: cleanup.release.target,
          userLifecycleVersion,
        });
      }
    }
    return claims;
  }

  async stopWorker(input: StopWorkerInput): Promise<void> {
    await this.removeWorker(input.workerId, "worker stopped", "release");
  }

  /**
   * worker 消失的唯一收尾路径：清索引、终结 run，再收资源。
   *
   * **不吞 provider 错误**:releaseResources 调用时,provider 清理失败必须
   * 传播给调用方。removeWorker 在 provider await 前 write-ahead 到 CleanupLedger，
   * 同一实例的并发 release 共用一个清理 Promise。
   * sweepFence / shutdown 等场景自行 catch。
   */
  private async removeWorker(
    workerId: string,
    reason: string,
    mode: WorkerRemovalMode,
    release?: ReleaseCleanupContext
  ): Promise<void> {
    const entry = this.pool.remove(workerId);
    if (!entry) return;

    this.handshakes.cancel(entry.workerId, reason);
    this.mailbox.cleanup(entry.workerId);

    // 先收口 Host 内的 run 状态，终态不依赖 provider 收资源成功。
    for (const runId of entry.activeRuns) {
      this.clearRunState(runId);
      this.upstream.notifyWorkerLost(runId, reason).catch(() => {});
    }

    if (mode === "exited" || !entry.runtimeInstanceId) return;

    if (!isRuntimeType(entry.runtimeType)) return;
    const provider = this.resolveProvider(entry.runtimeType);
    await this.cleanupLedger.run(
      this.makeRuntimeInstanceRef(entry),
      this.cleanupMetadata(entry),
      provider,
      "release",
      release
    );
  }

  releaseRun(input: RuntimeHostRunRef): void {
    this.clearRunState(input.runId);
  }

  // ── worker 生命周期 ─────────────────────────────────────────────────

  /** 取得或创建同一 identity + generation 的 worker。 */
  private acquireWorkerOnce(
    input: SubmitRunInput,
    identity: ReuseIdentity,
    runtimeTarget: RuntimeSpec,
    runConfig: RunConfig
  ): Promise<WorkerEntry> {
    const { placement } = input;

    return this.pool.acquireOnce(
      identity,
      placement.userLifecycleVersion,
      {
        userId: placement.userId,
        workspaceId: placement.workspaceId,
      },
      () => this.createWorkerAcquisition(input, identity, runtimeTarget, runConfig)
    );
  }

  /**
   * `result` 是 submit 可见结果；`lifetime` 跟踪 provider.start 到真正 settle，
   * cancellation 后还会等待 rollback。release 只等待 lifetime，因此不会早于
   * late provision 返回 ACK。
   */
  private createWorkerAcquisition(
    input: SubmitRunInput,
    identity: ReuseIdentity,
    runtimeTarget: RuntimeSpec,
    runConfig: RunConfig
  ): AcquisitionTask {
    const { placement } = input;
    const runtimeType = placement.runtimeType;
    if (!isRuntimeType(runtimeType)) {
      throw new Error(`unsupported runtimeType: ${runtimeType}`);
    }
    const startToken = randomUUID();
    const workerId = randomUUID();

    const entry: WorkerEntry = {
      workerId,
      isolation: {
        scope: identity.scope,
        subjectId: identity.subjectId,
      },
      runtimeType,
      userId: placement.userId,
      userLifecycleVersion: placement.userLifecycleVersion,
      workspaceIds: new Set([placement.workspaceId]),
      startToken,
      status: "starting",
      runtimeInstanceId: "",
      lastSeen: Date.now(),
      cancelledRuns: new Set(),
      activeRuns: new Set(),
    };
    this.pool.put(entry);

    const handshake = this.handshakes.waitForRegister(workerId, startToken);
    // provider.start 可能长期 pending；先安装 rejection handler，避免 timeout
    // cancel handshake 后直到 start settle 期间出现 unhandled rejection。
    void handshake.catch(() => {});
    const provider = this.resolveProvider(runtimeType);
    const attempt: WorkerLaunchAttempt = { cancelled: false };
    const abortController = new AbortController();
    const result = deferred<WorkerEntry>();

    // 构建 worker env
    const workerEnv = buildWorkerEnv(
      placement,
      startToken,
      workerId,
      runtimeType,
      runtimeTarget,
      runConfig,
      this.config.agentPluginPackages
    );

    const ctx: RuntimeLaunchContext = {
      runtimeType,
      workerId,
      runId: input.runId,
      workspaceId: placement.workspaceId,
      isolation: {
        scope: identity.scope,
        subjectId: identity.subjectId,
      },
      placement: runtimeTarget,
      workerEnv,
    };

    const onExit = () => {
      void this.removeWorker(workerId, "worker exited unexpectedly", "exited");
    };

    const cancelAttempt = (
      reason: Error,
      release?: ReleaseCleanupContext
    ) => {
      if (attempt.cancelled) {
        attempt.release ??= release;
        if (release && attempt.runtimeInstanceId) {
          void this.cleanupFailedLaunch(provider, entry, attempt).catch(() => {});
        }
        return;
      }
      attempt.cancelled = true;
      attempt.cancelReason = reason;
      attempt.release = release;
      abortController.abort(reason);
      this.handshakes.cancel(workerId, reason.message);
      this.pool.remove(workerId);
      this.mailbox.cleanup(workerId);
      result.reject(reason);
      if (attempt.runtimeInstanceId) {
        // 显式 catch 避免 onProvisioned 的 fire-and-forget 产生 unhandled rejection；
        // lifetime 会再次 await 同一个 cleanupPromise 并传播失败。
        void this.cleanupFailedLaunch(provider, entry, attempt).catch(() => {});
      }
    };

    const cancel = (release?: ReleaseCleanupContext) =>
      cancelAttempt(
        new Error(`worker launch cancelled for worker ${workerId}`),
        release
      );

    const timeout = setTimeout(
      () =>
        cancelAttempt(
          new Error(`worker launch timed out for worker ${workerId}`)
        ),
      this.config.launchTimeoutMs
    );
    timeout.unref?.();

    const start = Promise.resolve().then(() =>
      provider.start(
        ctx,
        onExit,
        (instanceId) => {
          attempt.runtimeInstanceId = instanceId;
          entry.runtimeInstanceId = instanceId;
          if (attempt.cancelled) {
            void this.cleanupFailedLaunch(provider, entry, attempt).catch(() => {});
          }
        },
        { signal: abortController.signal }
      )
    );

    const lifetime = (async () => {
      try {
        const launched = await start;
        attempt.runtimeInstanceId ??= launched.runtimeInstanceId;
        entry.runtimeInstanceId = launched.runtimeInstanceId;
        if (attempt.cancelled) throw attempt.cancelReason;

        await handshake;
        if (attempt.cancelled) throw attempt.cancelReason;

        this.pool.markReady(workerId, launched.runtimeInstanceId);
        const current = this.pool.getById(workerId);
        if (!current || current.workerId !== workerId) {
          throw new Error(`worker launch superseded for worker ${workerId}`);
        }
        result.resolve(current);
      } catch (error) {
        const failure =
          error instanceof Error
            ? error
            : new Error(String(error ?? `worker launch failed for ${workerId}`));
        if (!attempt.cancelled) {
          attempt.cancelled = true;
          attempt.cancelReason = failure;
          abortController.abort(failure);
          this.handshakes.cancel(workerId, failure.message);
        }
        this.pool.remove(workerId);
        this.mailbox.cleanup(workerId);
        try {
          await this.cleanupFailedLaunch(provider, entry, attempt);
        } catch (cleanupError) {
          result.reject(cleanupError);
          throw cleanupError;
        }
        result.reject(failure);
      } finally {
        clearTimeout(timeout);
        await handshake.catch(() => {});
      }
    })();

    return { result: result.promise, lifetime, cancel };
  }

  private onAcquired(runId: string, workerId: string, entry: WorkerEntry): void {
    if (!this.sessions.has(runId)) return;

    const placement = this.sessions.getPlacement(runId);
    if (placement) entry.workspaceIds.add(placement.workspaceId);

    // 就绪前到达的 cancel:state.cancelled 由 command() 标记(彼时 runIndex 还没
    // 建立,pool.markCancelled 不一定落上),两处标记任一命中都转 cancelled 终态。
    if (this.sessions.isCancelled(runId) || entry.cancelledRuns.delete(runId)) {
      this.pool.dissociateRun(runId);
      this.sessions.delete(runId);
      this.upstream.notifyRunCancelled(runId).catch(() => {});
      return;
    }

    this.sessions.bindWorker(runId, entry.workerId);
    this.pool.associateRun(workerId, runId);

    // 下发首条 user_message(runConfig 已在 submitRun 存入,worker 经 getRunConfig 拉取)
    this.dispatch(entry.workerId, runId, {
      type: "user_message",
      commandId: generateId(),
      runId,
    });
  }

  private onAcquireFailed(runId: string, err: unknown): void {
    if (!this.sessions.has(runId)) return;
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

  // ── worker HTTP 端点支持（仅供本 Host 的 WorkerHttpServer 调用） ────

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
    const entry = this.pool.getById(workerId);
    if (entry) this.pool.touch(workerId);

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
    const entry = this.pool.getById(workerId);
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
      throw new WorkerEventRequestError(
        `Worker ${workerId} does not own run ${runId}`
      );
    }
    const events = parseWorkerEventPostBody(body, runId);
    if (!events || events.length === 0) {
      throw new WorkerEventRequestError("Invalid worker event body");
    }
    if (events.some((event) => event.runId !== runId)) {
      throw new WorkerEventRequestError("Worker event runId mismatch");
    }
    // touch worker 心跳
    this.pool.touch(workerId);
    for (const event of events) {
      await this.upstream.emit(runId, event);
    }
    return { ok: true };
  }

  // ── shutdown / drain ────────────────────────────────────────────────

  /**
   * 幂等 shutdown:停止所有 worker,清理定时器。
   *
   * 并发 SIGINT/SIGTERM 安全:第二次调用返回同一 promise,不并发清理。
   * registered daemon 退出时调用。
   */
  async shutdown(): Promise<void> {
    // 并发信号返回同一 promise,不截断第一次清理
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = (async () => {
      this.drain();
      // shutdown 前 best-effort 推进内部 orphan cleanup；失败仍留账，不截断关停。
      await this.cleanupLedger.retryCleanupOnly();
      // 停止所有 worker(provider 清理失败 best-effort,不阻塞 shutdown)
      const workers = this.pool.list();
      for (const worker of workers) {
        await this.removeWorker(
          worker.workerId,
          "host shutdown",
          "release"
        ).catch(() => {});
      }
    })();
    return this.shutdownPromise;
  }

  // ── 工具 ────────────────────────────────────────────────────────────

  private clearRunState(runId: string): void {
    this.pool.dissociateRun(runId);
    this.sessions.delete(runId);
  }

  private makeRuntimeInstanceRef(entry: WorkerEntry): RuntimeInstanceRef {
    return {
      runtimeType: entry.runtimeType,
      workerId: entry.workerId,
      runtimeInstanceId: entry.runtimeInstanceId,
    };
  }

  /** 启动回滚也走同一 write-ahead/singleflight ledger。 */
  private async cleanupFailedLaunch(
    provider: RuntimeProvider,
    entry: WorkerEntry,
    attempt: WorkerLaunchAttempt
  ): Promise<void> {
    if (!attempt.runtimeInstanceId) return;
    const ref: RuntimeInstanceRef = {
      runtimeType: provider.type,
      workerId: entry.workerId,
      runtimeInstanceId: attempt.runtimeInstanceId,
    };
    await this.cleanupLedger.run(
      ref,
      this.cleanupMetadata(entry),
      provider,
      "destroy",
      attempt.release
    );
  }

  private cleanupMetadata(entry: WorkerEntry): CleanupMetadata {
    return {
      scope: entry.isolation.scope,
      subjectId: entry.isolation.subjectId,
      userId: entry.userId,
      userLifecycleVersion: entry.userLifecycleVersion,
      workspaceIds: [...entry.workspaceIds],
    };
  }

  private releaseContext(
    target: ReleaseRuntimeResourcesInput["target"]
  ): ReleaseCleanupContext {
    return target.type === "workspace"
      ? { target: { type: "workspace", workspaceId: target.workspaceId } }
      : {
          target: { type: "user", userId: target.userId },
          userLifecycleVersion: target.userLifecycleVersion,
        };
  }

  private sameReleaseTarget(
    left: ReleaseCleanupContext,
    right: ReleaseCleanupContext
  ): boolean {
    if (left.target.type !== right.target.type) return false;
    if (left.target.type === "workspace" && right.target.type === "workspace") {
      return left.target.workspaceId === right.target.workspaceId;
    }
    return (
      left.target.type === "user" &&
      right.target.type === "user" &&
      "userLifecycleVersion" in left &&
      "userLifecycleVersion" in right &&
      left.target.userId === right.target.userId &&
      left.userLifecycleVersion <= right.userLifecycleVersion
    );
  }

  /** 进程退出时清理定时器(不停止 worker,shutdown 才停)。 */
  drain(): void {
    this.mailbox.drain();
    if (this.fenceTimer) clearInterval(this.fenceTimer);
    if (this.capabilityTimer) clearInterval(this.capabilityTimer);
  }

  /**
   * 心跳判死扫描：pool 中 lastSeen 超过 heartbeatTimeoutMs 的 worker 判死。
   * 判死走与 stopWorker 相同的收尾(出池、清信箱、通知名下 run、停运行实例)。
   * provider 清理失败 best-effort(不阻塞扫描循环)。
   */
  private async sweepFence(): Promise<void> {
    // 复用既有 fence 周期推进 cleanup-only ledger；all-settled，不让单条失败
    // 阻塞其它 orphan cleanup，也不影响下方 heartbeat sweep。
    await this.cleanupLedger.retryCleanupOnly();
    const now = Date.now();
    const timeoutMs = this.config.heartbeatTimeoutMs;
    for (const worker of this.pool.list()) {
      if (worker.status !== "ready") continue;
      if (now - worker.lastSeen < timeoutMs) continue;
      await this.removeWorker(
        worker.workerId,
        "worker heartbeat timeout (fence)",
        "release"
      ).catch(() => {});
    }
  }
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
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
