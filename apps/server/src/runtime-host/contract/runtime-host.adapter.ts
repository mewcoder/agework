import { Inject, Injectable, Logger } from "@nestjs/common";
import { generateId, isTerminalRunStatus } from "@agework/shared";
import type {
  CreateDirectoryInput,
  DirectoryListing,
  HostCapabilityStatus,
  HostUpstreamNotification,
  HostListWorkersRpcResult,
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
  type RuntimeHostConnectivity,
  type RuntimeHostOwnerReconciliation,
  type RuntimeHostOwnerRef,
} from "../runtime-host.types";
import { ConfigService } from "../../config/config.service";
import { RunEventService } from "../../run-event/run-event.service";
import { BUILTIN_RUNTIME_HOST } from "./builtin-runtime-host";
import { HostTunnelHandler } from "../gateway/host-tunnel.handler";

/** CLI 安装要跑 npm install(上限 120s),隧道等待要给足余量。 */
const INSTALL_CLI_TIMEOUT_MS = 150_000;

/**
 * `RuntimeHostContract` 的 server 侧路由实现(目标架构设计文档 §7 Phase 2):
 * run 模块只经契约动词消费执行面,本类按 placement.runtimeHostId 分两路——
 * - **builtin**:进程内 RuntimeHost 库实例(`BUILTIN_RUNTIME_HOST`)，所有
 *   runtimeType 都在同一 Host 内按 provider 分派。
 * - **registered**:隧道在线的 Host，经 `host.*` 隧道 RPC 下发，事件流经
 *   `host.upstream`（ACK 水位）回流。
 *
 * RuntimeHostAdapter 是 builtin / registered 的唯一分流点；上层 Service
 * 只编排用例，不再自行直读执行机或拼 host.* RPC。
 */
@Injectable()
export class RuntimeHostAdapter
  implements
    RuntimeHostContract,
    RuntimeHostOwnerReconciliation,
    RuntimeHostConnectivity
{
  private readonly logger = new Logger(RuntimeHostAdapter.name);
  private upstream!: RuntimeHostUpstream;

  constructor(
    private readonly tunnelHandler: HostTunnelHandler,
    private readonly configService: ConfigService,
    private readonly runEvents: RunEventService,
    @Inject(BUILTIN_RUNTIME_HOST)
    private readonly builtinHost: RuntimeHost
  ) {}

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

  async submitRun(input: SubmitRunInput): Promise<void> {
    const { placement } = input;
    if (isBuiltinHostId(placement.runtimeHostId)) {
      // spec/config 组装失败在受理前同步抛出(配置/入参问题),由调用方按启动失败处理
      await this.builtinHost.submitRun(input);
      return;
    }
    await this.submitRunViaTunnel(input);
  }

  async command(input: RuntimeHostCommandInput): Promise<void> {
    if (isBuiltinHostId(input.runtimeHostId)) {
      // 就绪前 cancel 吸收、命令下发审计(onCommandDispatched)都在 Host 内
      await this.builtinHost.command(input);
      return;
    }
    await this.commandViaTunnel(input);
  }

  releaseRun(input: RuntimeHostRunRef): void {
    if (isBuiltinHostId(input.runtimeHostId)) {
      this.builtinHost.releaseRun(input);
      return;
    }
    // 隧道 Host 的状态清理:单向通知,best-effort(Host 掉线就等它的 fence 自清)
    this.tunnelHandler.sendNotification(input.runtimeHostId, {
      jsonrpc: "2.0",
      method: "host.releaseRun",
      params: input,
    });
  }

  // ── registered Host 隧道路径 ──────────────────────────────────────

  /** 通过隧道向 Host 发 submitRun。 */
  private async submitRunViaTunnel(input: SubmitRunInput): Promise<void> {
    const { runId, placement } = input;
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
      this.upstream
        .notifyRunFailed(runId, `tunnel submitRun failed: ${String(err)}`)
        .catch(() => {});
    }
  }

  /** 通过隧道向 Host 发 command。 */
  private async commandViaTunnel(
    input: RuntimeHostCommandInput
  ): Promise<void> {
    const { runtimeHostId, payload } = input;
    const { runId } = payload;
    // 「命令已下发」记账(进程内 Host 由 onCommandDispatched 钩子记,这里补隧道路径)
    this.runEvents
      .append(
        this.runEvents.commandSent({
          runId,
          commandId: payload.commandId,
          commandType: payload.type,
        })
      )
      .catch(() => {});
    try {
      const timeoutMs = this.configService.getLaunchTimeoutSeconds() * 1000;
      await this.tunnelHandler.sendRequest(
        runtimeHostId,
        {
          jsonrpc: "2.0",
          id: `${runId}:${payload.commandId}`,
          method: "host.command",
          params: input,
        },
        timeoutMs
      );
    } catch (err) {
      this.logger.warn(
        `tunnel command failed for run ${runId}: ${String(err)}`
      );
    }
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

  // ── 环境 / 文件 / 观测 契约方法 ─────────────────────────────────────

  async releaseOwner(input: ReleaseOwnerInput): Promise<void> {
    // 按 runtimeHostId 定向路由;目标 Host 无该 owner 的 worker 时为空操作(幂等)
    if (isBuiltinHostId(input.runtimeHostId)) {
      await this.builtinHost.releaseOwner(input);
      return;
    }
    await this.tunnelHandler.sendRequest<never>(
      input.runtimeHostId,
      {
        jsonrpc: "2.0",
        id: generateId(),
        method: "host.releaseOwner",
        params: input,
      },
      this.configService.getLaunchTimeoutSeconds() * 1000
    );
  }

  async detectEnv(runtimeHostId: string): Promise<HostCapabilityStatus> {
    if (isBuiltinHostId(runtimeHostId)) {
      return this.builtinHost.detectEnv(runtimeHostId);
    }
    return this.tunnelHandler.sendRequest<HostCapabilityStatus>(
      runtimeHostId,
      {
        jsonrpc: "2.0",
        id: generateId(),
        method: "host.detectEnv",
        params: { runtimeHostId },
      },
      this.configService.getLaunchTimeoutSeconds() * 1000
    );
  }

  async installCli(input: InstallCliInput): Promise<InstallCliResult> {
    if (isBuiltinHostId(input.runtimeHostId)) {
      return this.builtinHost.installCli(input);
    }
    return this.tunnelHandler.sendRequest<InstallCliResult>(
      input.runtimeHostId,
      {
        jsonrpc: "2.0",
        id: generateId(),
        method: "host.installCli",
        params: input,
      },
      INSTALL_CLI_TIMEOUT_MS
    );
  }

  async listDirectory(input: ListDirectoryInput): Promise<DirectoryListing> {
    if (isBuiltinHostId(input.runtimeHostId)) {
      return this.builtinHost.listDirectory(input);
    }
    return this.tunnelHandler.sendRequest<DirectoryListing>(
      input.runtimeHostId,
      {
        jsonrpc: "2.0",
        id: generateId(),
        method: "host.listDirectory",
        params: input,
      },
      this.configService.getLaunchTimeoutSeconds() * 1000
    );
  }

  async createDirectory(input: CreateDirectoryInput): Promise<void> {
    if (isBuiltinHostId(input.runtimeHostId)) {
      await this.builtinHost.createDirectory(input);
      return;
    }
    await this.tunnelHandler.sendRequest<never>(
      input.runtimeHostId,
      {
        jsonrpc: "2.0",
        id: generateId(),
        method: "host.createDirectory",
        params: input,
      },
      this.configService.getLaunchTimeoutSeconds() * 1000
    );
  }

  async listFiles(
    input: WorkspaceFileQuery
  ): Promise<WorkspaceFileListResponse> {
    if (isBuiltinHostId(input.runtimeHostId)) {
      return this.builtinHost.listFiles(input);
    }
    return this.tunnelHandler.sendRequest<WorkspaceFileListResponse>(
      input.runtimeHostId,
      {
        jsonrpc: "2.0",
        id: generateId(),
        method: "host.listFiles",
        params: input,
      },
      this.configService.getLaunchTimeoutSeconds() * 1000
    );
  }

  async readFile(input: ReadFileInput): Promise<WorkspaceFileReadResponse> {
    if (isBuiltinHostId(input.runtimeHostId)) {
      return this.builtinHost.readFile(input);
    }
    return this.tunnelHandler.sendRequest<WorkspaceFileReadResponse>(
      input.runtimeHostId,
      {
        jsonrpc: "2.0",
        id: generateId(),
        method: "host.readFile",
        params: input,
      },
      this.configService.getLaunchTimeoutSeconds() * 1000
    );
  }

  async readFileDiff(
    input: ReadFileDiffInput
  ): Promise<WorkspaceFileDiffResponse> {
    if (isBuiltinHostId(input.runtimeHostId)) {
      return this.builtinHost.readFileDiff(input);
    }
    return this.tunnelHandler.sendRequest<WorkspaceFileDiffResponse>(
      input.runtimeHostId,
      {
        jsonrpc: "2.0",
        id: generateId(),
        method: "host.readFileDiff",
        params: input,
      },
      this.configService.getLaunchTimeoutSeconds() * 1000
    );
  }

  async searchFiles(
    input: SearchFilesInput
  ): Promise<WorkspaceFileSearchResponse> {
    if (isBuiltinHostId(input.runtimeHostId)) {
      return this.builtinHost.searchFiles(input);
    }
    return this.tunnelHandler.sendRequest<WorkspaceFileSearchResponse>(
      input.runtimeHostId,
      {
        jsonrpc: "2.0",
        id: generateId(),
        method: "host.searchFiles",
        params: input,
      },
      this.configService.getLaunchTimeoutSeconds() * 1000
    );
  }

  async listChangedFiles(
    input: ListChangedFilesInput
  ): Promise<WorkspaceChangedFilesResponse> {
    if (isBuiltinHostId(input.runtimeHostId)) {
      return this.builtinHost.listChangedFiles(input);
    }
    return this.tunnelHandler.sendRequest<WorkspaceChangedFilesResponse>(
      input.runtimeHostId,
      {
        jsonrpc: "2.0",
        id: generateId(),
        method: "host.listChangedFiles",
        params: input,
      },
      this.configService.getLaunchTimeoutSeconds() * 1000
    );
  }

  async listWorkers(): Promise<WorkerSnapshot[]> {
    // 进程内 builtin Host + 所有隧道在线的 registered Host 现场查询；
    // 这是 worker 状态的唯一权威来源。Host 本地不知道自己的注册 id,
    // 快照的 runtimeHostId 在这里按路由来源盖章。
    const result = await this.listWorkersOn(BUILTIN_HOST_ID);
    const tunnelWorkers = await Promise.all(
      this.tunnelHandler
        .listConnected()
        .map(async (runtimeHostId): Promise<WorkerSnapshot[]> => {
          try {
            return await this.listWorkersOn(runtimeHostId);
          } catch (err) {
            this.logger.warn(
              `host.listWorkers failed for ${runtimeHostId}: ${String(err)}`
            );
            return [];
          }
        })
    );
    return result.concat(tunnelWorkers.flat());
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

  private async listWorkersOn(
    runtimeHostId: string
  ): Promise<WorkerSnapshot[]> {
    if (isBuiltinHostId(runtimeHostId)) {
      return (await this.builtinHost.listWorkers()).map((worker) => ({
        ...worker,
        runtimeHostId: BUILTIN_HOST_ID,
      }));
    }
    const hostResult =
      await this.tunnelHandler.sendRequest<HostListWorkersRpcResult>(
        runtimeHostId,
        {
          jsonrpc: "2.0",
          id: generateId(),
          method: "host.listWorkers",
          params: {},
        },
        this.configService.getLaunchTimeoutSeconds() * 1000
      );
    return hostResult.workers.map((worker) => ({
      ...worker,
      runtimeHostId,
    }));
  }

  async stopWorker(input: StopWorkerInput): Promise<void> {
    // 按 runtimeHostId 定向路由;WorkerKey = `${OwnerKey}#${RuntimeType}`。
    if (isBuiltinHostId(input.runtimeHostId)) {
      await this.builtinHost.stopWorker(input);
      return;
    }
    await this.tunnelHandler.sendRequest<never>(
      input.runtimeHostId,
      {
        jsonrpc: "2.0",
        id: generateId(),
        method: "host.stopWorker",
        params: input,
      },
      this.configService.getLaunchTimeoutSeconds() * 1000
    );
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
