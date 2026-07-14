import { Inject, Injectable, Logger } from "@nestjs/common";
import { generateId } from "@agework/shared";
import { normalizeRuntimeCapabilities } from "@agework/shared/protocol";
import type {
  CommandPayload,
  CreateDirectoryInput,
  DirectoryListing,
  ExecutionRef,
  HostCapabilityStatus,
  HostUpstreamNotification,
  HostListWorkersRpcResult,
  InstallCliInput,
  InstallCliResult,
  ListChangedFilesInput,
  ListDirectoryInput,
  OwnerKey,
  ReadFileDiffInput,
  ReadFileInput,
  RuntimeHostContract,
  RuntimeHostUpstream,
  SearchFilesInput,
  SubmitRunInput,
  WorkerKey,
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
import type { RuntimeHost } from "@agework/runtime/host";
import { RuntimeService } from "../../runtime/runtime.service";
import { isBuiltinHostId } from "../../runtime/runtime.types";
import { ConfigService } from "../../config/config.service";
import { RunEventService } from "../../run-event/run-event.service";
import { MANAGED_RUNTIME_HOST } from "./managed-runtime-host";

/** 一次已提交 run 的路由状态:command/releaseRun 需要知道该 run 落在哪台 Host。 */
type SubmittedRunState = {
  runtimeHostId: string;
};

/**
 * `RuntimeHostContract` 的 server 侧路由实现(目标架构设计文档 §7 Phase 2):
 * run 模块只经契约动词消费执行面,本类按 placement.runtimeHostId 分两路——
 * - **builtin**:进程内 RuntimeHost 库实例(`MANAGED_RUNTIME_HOST`)，所有
 *   runtimeType 都在同一 Host 内按 provider 分派。
 * - **registered**:隧道在线的 Host，经 `host.*` 隧道 RPC 下发，事件流经
 *   `host.upstream`（ACK 水位）回流。
 *
 * 旧 worker-manager 执行栈(connection/instance/registry)自此不再被任何
 * 新 run 触达,Worker 表停写(表结构保留,Phase 3 删除)。
 */
@Injectable()
export class RuntimeHostAdapter implements RuntimeHostContract {
  private readonly logger = new Logger(RuntimeHostAdapter.name);
  private readonly states = new Map<string, SubmittedRunState>();
  private upstream!: RuntimeHostUpstream;

  constructor(
    private readonly runtimeService: RuntimeService,
    private readonly configService: ConfigService,
    private readonly runEvents: RunEventService,
    @Inject(MANAGED_RUNTIME_HOST)
    private readonly managedHost: RuntimeHost
  ) {}

  setUpstream(upstream: RuntimeHostUpstream): void {
    this.upstream = upstream;
    // 进程内 builtin Host 直接回流；registered Host 的事件经隧道回流
    this.managedHost.setUpstream(upstream);
    this.runtimeService.setTunnelUpstreamHandler((runtimeId, notification) =>
      this.onTunnelUpstream(runtimeId, notification, upstream)
    );
  }

  async submitRun(input: SubmitRunInput): Promise<void> {
    const { runId, placement } = input;
    if (this.states.has(runId)) return; // 幂等：同 runId 重复提交是空操作

    this.states.set(runId, { runtimeHostId: placement.runtimeHostId });
    if (isBuiltinHostId(placement.runtimeHostId)) {
      // spec/config 组装失败在受理前同步抛出(配置/入参问题),由调用方按启动失败处理
      try {
        await this.managedHost.submitRun(input);
      } catch (err) {
        this.states.delete(runId);
        throw err;
      }
      return;
    }
    await this.submitRunViaTunnel(input);
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
    if (isBuiltinHostId(state.runtimeHostId)) {
      // 就绪前 cancel 吸收、命令下发审计(onCommandDispatched)都在 Host 内
      await this.managedHost.command(runId, payload);
      return;
    }
    await this.commandViaTunnel(state.runtimeHostId, runId, payload);
  }

  releaseRun(runId: string): void {
    const state = this.states.get(runId);
    this.states.delete(runId);
    if (!state || isBuiltinHostId(state.runtimeHostId)) {
      this.managedHost.releaseRun(runId);
      return;
    }
    // 隧道 Host 的状态清理:单向通知,best-effort(Host 掉线就等它的 fence 自清)
    this.runtimeService.sendTunnelNotification(state.runtimeHostId, {
      jsonrpc: "2.0",
      method: "host.releaseRun",
      params: { runId },
    });
  }

  // ── registered Host 隧道路径 ──────────────────────────────────────

  /** 通过隧道向 Host 发 submitRun。 */
  private async submitRunViaTunnel(input: SubmitRunInput): Promise<void> {
    const { runId, placement } = input;
    try {
      const timeoutMs = this.configService.getLaunchTimeoutSeconds() * 1000;
      await this.runtimeService.sendTunnelRequest(
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

  /** 通过隧道向 Host 发 command。 */
  private async commandViaTunnel(
    runtimeHostId: string,
    runId: string,
    payload: CommandPayload
  ): Promise<void> {
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
      await this.runtimeService.sendTunnelRequest(
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
      this.logger.warn(
        `tunnel command failed for run ${runId}: ${String(err)}`
      );
    }
  }

  /** 隧道 upstream 通知 → RuntimeHostUpstream 回流。
   *  返回 Promise:隧道 handler 串行 await 后才回 ACK 水位(传输不丢)。 */
  private async onTunnelUpstream(
    runtimeId: string,
    notification: HostUpstreamNotification,
    upstream: RuntimeHostUpstream
  ): Promise<void> {
    // server 重启后 states 丢失:Host 按 ACK 水位补发事件流,从续传的第一条
    // 通知重建路由状态(后续 cancel/resume 命令需要 runtimeHostId)。
    // 已终结 run 的迟到通知也会建条目,靠 run 侧 releaseRun 或下次重启清掉。
    if (!this.states.has(notification.runId)) {
      this.states.set(notification.runId, { runtimeHostId: runtimeId });
    }
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
      case "executionRef":
        upstream.notifyExecutionRef(notification.runId, notification.ref);
        break;
    }
  }

  async sendRecoveryCancel(_input: {
    runId: string;
    conversationId: string;
    ref: ExecutionRef;
  }): Promise<void> {
    // managed-native worker 随 server 同生共死;managed 容器 Host 重启后池已清空,
    // 旧容器里的 worker 回连时 token 校验 410,自行退出(孤儿自清)。无需补发 cancel。
  }

  async getWorkerSnapshotForAdmin(
    ref: ExecutionRef
  ): Promise<WorkerSnapshot | null> {
    const workers = await this.listWorkers();
    return (
      workers.find((w) => w.runtimeInstanceId === ref.runtimeInstanceId) ?? null
    );
  }

  // ── 环境 / 文件 / 观测 契约方法 ─────────────────────────────────────

  async releaseOwner(owner: OwnerKey): Promise<void> {
    // 进程内 Host + 所有隧道在线 Host 广播(无该 owner 的 Host 是空操作,幂等)
    await this.managedHost.releaseOwner(owner);
    for (const runtimeId of this.runtimeService.listConnectedRuntimeIds()) {
      try {
        const timeoutMs = this.configService.getLaunchTimeoutSeconds() * 1000;
        await this.runtimeService.sendTunnelRequest<never>(
          runtimeId,
          {
            jsonrpc: "2.0",
            id: generateId(),
            method: "host.releaseOwner",
            params: { owner },
          },
          timeoutMs
        );
      } catch (err) {
        this.logger.warn(
          `host.releaseOwner failed for ${owner} on host ${runtimeId}: ${String(err)}`
        );
      }
    }
  }

  async detectEnv(runtimeHostId: string): Promise<HostCapabilityStatus> {
    const row = await this.runtimeService.getRuntimeHostRow(runtimeHostId);
    if (!row) {
      throw new Error(`runtime host not found: ${runtimeHostId}`);
    }
    const capabilities = normalizeRuntimeCapabilities(row.capabilities);
    const envConfig = row.envConfig as RuntimeEnvConfig | null;
    if (!envConfig || !capabilities.native) return capabilities;
    return {
      ...capabilities,
      native: { ...capabilities.native, cli: envConfig },
    } satisfies HostCapabilityStatus;
  }

  async installCli(input: InstallCliInput): Promise<InstallCliResult> {
    const { runtimeHostId, agentType } = input;
    const result = await this.runtimeService.installCli(
      runtimeHostId,
      agentType
    );
    if (!result.envConfig) {
      throw new Error(
        `installCli failed: no envConfig returned for ${runtimeHostId}`
      );
    }
    return { envConfig: result.envConfig };
  }

  async listDirectory(input: ListDirectoryInput): Promise<DirectoryListing> {
    if (isBuiltinHostId(input.runtimeHostId)) {
      return this.managedHost.listDirectory(input);
    }
    return this.runtimeService.sendTunnelRequest<DirectoryListing>(
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
      await this.managedHost.createDirectory(input);
      return;
    }
    await this.runtimeService.sendTunnelRequest<never>(
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
      return this.managedHost.listFiles(input);
    }
    return this.runtimeService.sendTunnelRequest<WorkspaceFileListResponse>(
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
      return this.managedHost.readFile(input);
    }
    return this.runtimeService.sendTunnelRequest<WorkspaceFileReadResponse>(
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
      return this.managedHost.readFileDiff(input);
    }
    return this.runtimeService.sendTunnelRequest<WorkspaceFileDiffResponse>(
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
      return this.managedHost.searchFiles(input);
    }
    return this.runtimeService.sendTunnelRequest<WorkspaceFileSearchResponse>(
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
      return this.managedHost.listChangedFiles(input);
    }
    return this.runtimeService.sendTunnelRequest<WorkspaceChangedFilesResponse>(
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
    // 进程内 Host(managed-native)+ 所有隧道在线 Host(managed 容器型 + registered)
    // 现场查询;Worker 表停写后这是唯一权威来源
    const result = await this.managedHost.listWorkers();
    for (const runtimeId of this.runtimeService.listConnectedRuntimeIds()) {
      try {
        const timeoutMs = this.configService.getLaunchTimeoutSeconds() * 1000;
        const hostResult =
          await this.runtimeService.sendTunnelRequest<HostListWorkersRpcResult>(
            runtimeId,
            {
              jsonrpc: "2.0",
              id: generateId(),
              method: "host.listWorkers",
              params: {},
            },
            timeoutMs
          );
        result.push(...hostResult.workers);
      } catch (err) {
        this.logger.warn(
          `host.listWorkers failed for ${runtimeId}: ${String(err)}`
        );
      }
    }
    return result;
  }

  async stopWorker(key: WorkerKey): Promise<void> {
    // WorkerKey = `${OwnerKey}#${RuntimeType}`。进程内 Host + 隧道广播,
    // 持有该 key 的 Host 停掉对应 worker,其余 Host 空操作(幂等)。
    await this.managedHost.stopWorker(key);
    for (const runtimeId of this.runtimeService.listConnectedRuntimeIds()) {
      try {
        const timeoutMs = this.configService.getLaunchTimeoutSeconds() * 1000;
        await this.runtimeService.sendTunnelRequest<never>(
          runtimeId,
          {
            jsonrpc: "2.0",
            id: generateId(),
            method: "host.stopWorker",
            params: { key },
          },
          timeoutMs
        );
      } catch (err) {
        this.logger.warn(
          `host.stopWorker failed for ${key} on host ${runtimeId}: ${String(err)}`
        );
      }
    }
  }
}
