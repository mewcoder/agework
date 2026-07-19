import { Inject, Injectable, Logger } from "@nestjs/common";
import { isTerminalRunStatus } from "@agework/shared";
import type {
  CreateDirectoryInput,
  DirectoryListing,
  HostCapabilityStatus,
  HostUpstreamNotification,
  InstallCliInput,
  InstallCliResult,
  ListChangedFilesInput,
  ListDirectoryInput,
  ReadFileDiffInput,
  ReadFileInput,
  ReleaseOwnerInput,
  RunStatusPayload,
  RuntimeHostContract,
  RuntimeHostCommandInput,
  RuntimeHostRunRef,
  RuntimeHostUpstream,
  SearchFilesInput,
  StopWorkerInput,
  SubmitRunInput,
  WorkerSnapshot,
  WorkspaceFileQuery,
} from "@agework/shared/protocol";
import type {
  WorkspaceChangedFilesResponse,
  WorkspaceFileDiffResponse,
  WorkspaceFileListResponse,
  WorkspaceFileReadResponse,
  WorkspaceFileSearchResponse,
} from "@agework/shared/api";
import type { RuntimeHost } from "@agework/runtime/host";
import {
  BUILTIN_HOST_ID,
  isBuiltinHostId,
  type HostRunReapBinding,
  type HostRunReapPort,
  type RuntimeHostConnectivity,
  type RuntimeHostOwnerReconciliation,
  type RuntimeHostOwnerRef,
  type RuntimeHostRunReconciliation,
} from "../runtime-host.types";
import { RunEventService } from "../../run-event/run-event.service";
import { BUILTIN_RUNTIME_HOST } from "./builtin-runtime-host";
import { HostTunnelHandler } from "../gateway/host-tunnel.handler";
import {
  TunnelRuntimeHost,
  type RoutedRuntimeHost,
} from "./tunnel-runtime-host";

/**
 * `RuntimeHostContract` 的 server 侧路由实现(目标架构设计文档 §7 Phase 2):
 * run 模块只经契约动词消费执行面,本类按 placement.runtimeHostId 分两路——
 * - **builtin**:进程内 RuntimeHost 库实例(`BUILTIN_RUNTIME_HOST`)，所有
 *   runtimeType 都在同一 Host 内按 provider 分派。
 * - **registered**:隧道在线的 Host,经 `TunnelRuntimeHost` 的 `host.*` 隧道
 *   RPC 下发,事件流经 `host.upstream`（ACK 水位）回流。
 *
 * `route()` 是 builtin / registered 的唯一分流点:纯下发面动词按 Host id 二选一
 * 直投;少数带跨面副作用的(命令记账、submitRun 失败通知、builtin+registered
 * 快照合并)在本类显式编排。上层 Service 只编排用例,不再自行直读执行机或拼
 * host.* RPC。
 */
@Injectable()
export class RuntimeHostAdapter
  implements
    RuntimeHostContract,
    RuntimeHostOwnerReconciliation,
    RuntimeHostRunReconciliation,
    RuntimeHostConnectivity,
    HostRunReapBinding
{
  private readonly logger = new Logger(RuntimeHostAdapter.name);
  private upstream!: RuntimeHostUpstream;

  constructor(
    private readonly tunnelHandler: HostTunnelHandler,
    private readonly tunnelHost: TunnelRuntimeHost,
    private readonly runEvents: RunEventService,
    @Inject(BUILTIN_RUNTIME_HOST)
    private readonly builtinHost: RuntimeHost
  ) {}

  /** 按 runtimeHostId 取对应下发面:builtin 进程内实例 / registered 隧道 stub。 */
  private route(runtimeHostId: string): RoutedRuntimeHost {
    return isBuiltinHostId(runtimeHostId) ? this.builtinHost : this.tunnelHost;
  }

  setUpstream(upstream: RuntimeHostUpstream): void {
    this.upstream = upstream;
    // 进程内 builtin Host 直接回流；registered Host 的事件经隧道回流
    this.builtinHost.setUpstream(upstream);
    // 实现并接线 Runtime Host 模块定义的 host.upstream 回流 Port
    this.tunnelHandler.setHostUpstreamPort({
      onHostUpstream: (runtimeHostId, notification) =>
        this.onTunnelUpstream(runtimeHostId, notification, upstream),
    });
  }

  isConnected(runtimeHostId: string): boolean {
    return (
      isBuiltinHostId(runtimeHostId) ||
      this.tunnelHandler.isConnected(runtimeHostId)
    );
  }

  /** 接线 run 上层的 Host 终态收尾端口(启动期一次),转交隧道网关在进程更替 /
   *  优雅关停时同步调用。 */
  setRunReapPort(port: HostRunReapPort): void {
    this.tunnelHandler.setHostRunReapPort(port);
  }

  async submitRun(input: SubmitRunInput): Promise<void> {
    if (isBuiltinHostId(input.placement.runtimeHostId)) {
      // spec/config 组装失败在受理前同步抛出(配置/入参问题),由调用方按启动失败处理
      await this.builtinHost.submitRun(input);
      return;
    }
    // 隧道传输失败发生在受理之后(异步),吞错并转 upstream 判死
    await this.tunnelHost.submitRun(input).catch((err) => {
      this.upstream
        .notifyRunFailed(input.runId, `tunnel submitRun failed: ${String(err)}`)
        .catch(() => {});
    });
  }

  async command(input: RuntimeHostCommandInput): Promise<void> {
    if (isBuiltinHostId(input.runtimeHostId)) {
      // 就绪前 cancel 吸收、命令下发审计(onCommandDispatched)都在 Host 内
      await this.builtinHost.command(input);
      return;
    }
    // 「命令已下发」记账(进程内 Host 由 onCommandDispatched 钩子记,这里补隧道路径)
    const { runId, commandId, type } = input.payload;
    this.runEvents
      .append(
        this.runEvents.commandSent({ runId, commandId, commandType: type })
      )
      .catch(() => {});
    await this.tunnelHost.command(input).catch((err) => {
      this.logger.warn(
        `tunnel command failed for run ${runId}: ${String(err)}`
      );
      throw err;
    });
  }

  releaseRun(input: RuntimeHostRunRef): void {
    this.route(input.runtimeHostId).releaseRun(input);
  }

  /** 隧道 upstream 通知 → RuntimeHostUpstream 回流。
   *  返回 Promise:隧道 handler 串行 await 后才回 ACK 水位(传输不丢)。 */
  private async onTunnelUpstream(
    runtimeHostId: string,
    notification: HostUpstreamNotification,
    upstream: RuntimeHostUpstream
  ): Promise<void> {
    switch (notification.kind) {
      case "emit":
        await upstream.emit(notification.runId, notification.message);
        break;
      case "runFailed":
        await upstream.notifyRunFailed(notification.runId, notification.error);
        break;
      case "runCancelled":
        await upstream.notifyRunCancelled(notification.runId);
        break;
      case "workerLost":
        await upstream.notifyWorkerLost(
          notification.runId,
          notification.reason
        );
        break;
    }
    if (isTerminalHostNotification(notification)) {
      this.releaseRun({ runtimeHostId, runId: notification.runId });
    }
  }

  // ── 环境 / 文件 / 观测 契约方法（按 runtimeHostId 定向分派） ───────────

  async releaseOwner(input: ReleaseOwnerInput): Promise<void> {
    // 目标 Host 无该 owner 的 worker 时为空操作(幂等)
    await this.route(input.runtimeHostId).releaseOwner(input);
  }

  async detectEnv(runtimeHostId: string): Promise<HostCapabilityStatus> {
    return this.route(runtimeHostId).detectEnv(runtimeHostId);
  }

  async installCli(input: InstallCliInput): Promise<InstallCliResult> {
    return this.route(input.runtimeHostId).installCli(input);
  }

  async listDirectory(input: ListDirectoryInput): Promise<DirectoryListing> {
    return this.route(input.runtimeHostId).listDirectory(input);
  }

  async createDirectory(input: CreateDirectoryInput): Promise<void> {
    await this.route(input.runtimeHostId).createDirectory(input);
  }

  async listFiles(
    input: WorkspaceFileQuery
  ): Promise<WorkspaceFileListResponse> {
    return this.route(input.runtimeHostId).listFiles(input);
  }

  async readFile(input: ReadFileInput): Promise<WorkspaceFileReadResponse> {
    return this.route(input.runtimeHostId).readFile(input);
  }

  async readFileDiff(
    input: ReadFileDiffInput
  ): Promise<WorkspaceFileDiffResponse> {
    return this.route(input.runtimeHostId).readFileDiff(input);
  }

  async searchFiles(
    input: SearchFilesInput
  ): Promise<WorkspaceFileSearchResponse> {
    return this.route(input.runtimeHostId).searchFiles(input);
  }

  async listChangedFiles(
    input: ListChangedFilesInput
  ): Promise<WorkspaceChangedFilesResponse> {
    return this.route(input.runtimeHostId).listChangedFiles(input);
  }

  async stopWorker(input: StopWorkerInput): Promise<void> {
    // 按 runtimeHostId 定向路由;WorkerKey = `${OwnerKey}#${RuntimeType}`。
    await this.route(input.runtimeHostId).stopWorker(input);
  }

  async listWorkers(): Promise<WorkerSnapshot[]> {
    // 进程内 builtin Host + 所有隧道在线的 registered Host 现场查询；
    // 这是 worker 状态的唯一权威来源。Host 本地不知道自己的注册 id,
    // 快照的 runtimeHostId 在这里/隧道 stub 里按路由来源盖章。
    const builtin = await this.builtinWorkers();
    const tunnel = await this.tunnelHost.listWorkers();
    return builtin.concat(tunnel);
  }

  async listOwners(runtimeHostId?: string): Promise<RuntimeHostOwnerRef[]> {
    const workers = runtimeHostId
      ? await this.listWorkersOn(runtimeHostId)
      : await this.listWorkers();
    const refs = new Map<string, RuntimeHostOwnerRef>();
    for (const worker of workers) {
      if (worker.scope !== "workspace" && worker.scope !== "user") continue;
      const owner = `${worker.scope}:${worker.ownerId}` as const;
      const ref = { runtimeHostId: worker.runtimeHostId, owner };
      refs.set(`${ref.runtimeHostId}\0${ref.owner}`, ref);
    }
    return [...refs.values()];
  }

  /** Server 重启恢复只对账 runId，不把 admin Worker 诊断形状泄漏给 run 模块。 */
  async listRunIds(runtimeHostId: string): Promise<string[]> {
    return isBuiltinHostId(runtimeHostId)
      ? this.builtinHost.listRunIds()
      : this.tunnelHost.listRunIdsOn(runtimeHostId);
  }

  private listWorkersOn(runtimeHostId: string): Promise<WorkerSnapshot[]> {
    return isBuiltinHostId(runtimeHostId)
      ? this.builtinWorkers()
      : this.tunnelHost.listWorkersOn(runtimeHostId);
  }

  /** 进程内 builtin Host 的 worker 快照;Host 本地 runtimeHostId 为空,这里盖章。 */
  private async builtinWorkers(): Promise<WorkerSnapshot[]> {
    return (await this.builtinHost.listWorkers()).map((worker) => ({
      ...worker,
      runtimeHostId: BUILTIN_HOST_ID,
    }));
  }
}

function isTerminalHostNotification(
  notification: HostUpstreamNotification
): boolean {
  if (notification.kind !== "emit") return true;
  if (notification.message.type !== "run.status") return false;
  const payload = notification.message.payload as RunStatusPayload;
  return isTerminalRunStatus(payload.status);
}
