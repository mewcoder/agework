import { Injectable, Logger } from "@nestjs/common";
import { generateId } from "@agework/shared";
import type {
  CreateDirectoryInput,
  DirectoryListing,
  HostCapabilityStatus,
  HostListWorkersRpcResult,
  InstallCliInput,
  InstallCliResult,
  ListChangedFilesInput,
  ListDirectoryInput,
  ReadFileDiffInput,
  ReadFileInput,
  ReleaseOwnerInput,
  RuntimeHostCommandInput,
  RuntimeHostRunRef,
  RuntimeHostEnvironment,
  RuntimeHostExecution,
  RuntimeHostOwnerLifecycle,
  RuntimeHostWorkspaceData,
  RuntimeHostDiagnostics,
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
import { ConfigService } from "../../config/config.service";
import { HostTunnelHandler } from "../gateway/host-tunnel.handler";

/** CLI 安装要跑 npm install(上限 120s),隧道等待要给足余量。 */
const INSTALL_CLI_TIMEOUT_MS = 150_000;

/**
 * 可按 `runtimeHostId` 定向分派的 Host 下发面——builtin(进程内 `RuntimeHost`)
 * 与 registered(本类,隧道)两实现共有。`RuntimeHostAdapter.route()` 按 Host id
 * 在两者间二选一后直调此面。
 *
 * 不含 `setUpstream`(启动期接线,Adapter 编排)与无参 `listWorkers`(跨
 * builtin+registered 的聚合,Adapter 编排);单 Host 现场查询另经 `listWorkersOn`。
 */
export type RoutedRuntimeHost = RuntimeHostExecution &
  RuntimeHostOwnerLifecycle &
  RuntimeHostEnvironment &
  RuntimeHostWorkspaceData &
  Pick<RuntimeHostDiagnostics, "stopWorker">;

/**
 * `RoutedRuntimeHost` 的 registered 实现:把每个契约动词映射成隧道上对应的
 * `host.*` JSON-RPC(经 `HostTunnelHandler` 下发),概念上是 daemon 侧
 * `RuntimeHost` 的远程 stub。只做「契约方法 → 隧道 RPC」的纯拼装,业务编排
 * (命令记账、submitRun 失败通知、builtin+registered 合并)留在 `RuntimeHostAdapter`。
 */
@Injectable()
export class TunnelRuntimeHost implements RoutedRuntimeHost {
  private readonly logger = new Logger(TunnelRuntimeHost.name);

  constructor(
    private readonly tunnelHandler: HostTunnelHandler,
    private readonly configService: ConfigService
  ) {}

  private get timeoutMs(): number {
    return this.configService.getLaunchTimeoutSeconds() * 1000;
  }

  // ── 执行 ────────────────────────────────────────────────────────────

  /** 裸隧道下发;失败向调用方抛出,由 Adapter 转 notifyRunFailed。 */
  async submitRun(input: SubmitRunInput): Promise<void> {
    await this.tunnelHandler.sendRequest<never>(
      input.placement.runtimeHostId,
      {
        jsonrpc: "2.0",
        id: input.runId,
        method: "host.submitRun",
        params: input,
      },
      this.timeoutMs
    );
  }

  /** 裸隧道下发;失败向调用方抛出,由 Adapter 记日志(命令记账也在 Adapter)。 */
  async command(input: RuntimeHostCommandInput): Promise<void> {
    const { runId, commandId } = input.payload;
    await this.tunnelHandler.sendRequest<never>(
      input.runtimeHostId,
      {
        jsonrpc: "2.0",
        id: `${runId}:${commandId}`,
        method: "host.command",
        params: input,
      },
      this.timeoutMs
    );
  }

  /** 隧道 Host 的状态清理:单向通知,best-effort(Host 掉线就等它的 fence 自清)。 */
  releaseRun(input: RuntimeHostRunRef): void {
    this.tunnelHandler.sendNotification(input.runtimeHostId, {
      jsonrpc: "2.0",
      method: "host.releaseRun",
      params: input,
    });
  }

  async releaseOwner(input: ReleaseOwnerInput): Promise<void> {
    await this.tunnelHandler.sendRequest<never>(
      input.runtimeHostId,
      {
        jsonrpc: "2.0",
        id: generateId(),
        method: "host.releaseOwner",
        params: input,
      },
      this.timeoutMs
    );
  }

  // ── 环境 ────────────────────────────────────────────────────────────

  async detectEnv(runtimeHostId: string): Promise<HostCapabilityStatus> {
    return this.tunnelHandler.sendRequest<HostCapabilityStatus>(
      runtimeHostId,
      {
        jsonrpc: "2.0",
        id: generateId(),
        method: "host.detectEnv",
        params: { runtimeHostId },
      },
      this.timeoutMs
    );
  }

  async installCli(input: InstallCliInput): Promise<InstallCliResult> {
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

  // ── 工作空间文件 ────────────────────────────────────────────────────

  async listDirectory(input: ListDirectoryInput): Promise<DirectoryListing> {
    return this.tunnelHandler.sendRequest<DirectoryListing>(
      input.runtimeHostId,
      {
        jsonrpc: "2.0",
        id: generateId(),
        method: "host.listDirectory",
        params: input,
      },
      this.timeoutMs
    );
  }

  async createDirectory(input: CreateDirectoryInput): Promise<void> {
    await this.tunnelHandler.sendRequest<never>(
      input.runtimeHostId,
      {
        jsonrpc: "2.0",
        id: generateId(),
        method: "host.createDirectory",
        params: input,
      },
      this.timeoutMs
    );
  }

  async listFiles(
    input: WorkspaceFileQuery
  ): Promise<WorkspaceFileListResponse> {
    return this.tunnelHandler.sendRequest<WorkspaceFileListResponse>(
      input.runtimeHostId,
      {
        jsonrpc: "2.0",
        id: generateId(),
        method: "host.listFiles",
        params: input,
      },
      this.timeoutMs
    );
  }

  async readFile(input: ReadFileInput): Promise<WorkspaceFileReadResponse> {
    return this.tunnelHandler.sendRequest<WorkspaceFileReadResponse>(
      input.runtimeHostId,
      {
        jsonrpc: "2.0",
        id: generateId(),
        method: "host.readFile",
        params: input,
      },
      this.timeoutMs
    );
  }

  async readFileDiff(
    input: ReadFileDiffInput
  ): Promise<WorkspaceFileDiffResponse> {
    return this.tunnelHandler.sendRequest<WorkspaceFileDiffResponse>(
      input.runtimeHostId,
      {
        jsonrpc: "2.0",
        id: generateId(),
        method: "host.readFileDiff",
        params: input,
      },
      this.timeoutMs
    );
  }

  async searchFiles(
    input: SearchFilesInput
  ): Promise<WorkspaceFileSearchResponse> {
    return this.tunnelHandler.sendRequest<WorkspaceFileSearchResponse>(
      input.runtimeHostId,
      {
        jsonrpc: "2.0",
        id: generateId(),
        method: "host.searchFiles",
        params: input,
      },
      this.timeoutMs
    );
  }

  async listChangedFiles(
    input: ListChangedFilesInput
  ): Promise<WorkspaceChangedFilesResponse> {
    return this.tunnelHandler.sendRequest<WorkspaceChangedFilesResponse>(
      input.runtimeHostId,
      {
        jsonrpc: "2.0",
        id: generateId(),
        method: "host.listChangedFiles",
        params: input,
      },
      this.timeoutMs
    );
  }

  // ── 观测 ────────────────────────────────────────────────────────────

  async stopWorker(input: StopWorkerInput): Promise<void> {
    await this.tunnelHandler.sendRequest<never>(
      input.runtimeHostId,
      {
        jsonrpc: "2.0",
        id: generateId(),
        method: "host.stopWorker",
        params: input,
      },
      this.timeoutMs
    );
  }

  /** 所有隧道在线 registered Host 的 worker 快照聚合;单 Host 失败只记日志不影响其余。 */
  async listWorkers(): Promise<WorkerSnapshot[]> {
    const perHost = await Promise.all(
      this.tunnelHandler.listConnected().map(async (runtimeHostId) => {
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
    return perHost.flat();
  }

  /** 单个 registered Host 的现场查询;快照的 runtimeHostId 按路由来源盖章。 */
  async listWorkersOn(runtimeHostId: string): Promise<WorkerSnapshot[]> {
    const hostResult =
      await this.tunnelHandler.sendRequest<HostListWorkersRpcResult>(
        runtimeHostId,
        {
          jsonrpc: "2.0",
          id: generateId(),
          method: "host.listWorkers",
          params: {},
        },
        this.timeoutMs
      );
    return hostResult.workers.map((worker) => ({
      ...worker,
      runtimeHostId,
    }));
  }
}
