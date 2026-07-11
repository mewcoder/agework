import { randomUUID } from "node:crypto";
import { JSON_RPC_VERSION } from "@agework/shared/protocol/rpc";
import type {
  RuntimeCreateDirRpcParams,
  RuntimeCreateDirRpcResult,
  RuntimeInstanceRefRpcParams,
  RuntimeLaunchRpcParams,
  RuntimeLaunchRpcResult,
  RuntimeListDirRpcParams,
  RuntimeListDirRpcResult,
  RuntimeListFilesRpcParams,
  RuntimeListFilesRpcResult,
  RuntimeReadFileRpcParams,
  RuntimeReadFileRpcResult,
  RuntimeListChangedFilesRpcParams,
  RuntimeListChangedFilesRpcResult,
  RuntimeReadFileDiffRpcParams,
  RuntimeReadFileDiffRpcResult,
  RuntimeSearchFilesRpcParams,
  RuntimeSearchFilesRpcResult,
  RuntimeTunnelRpcRequest,
} from "@agework/shared/protocol";
import type {
  RuntimeEnvConfig,
  WorkspaceFileListResponse,
  WorkspaceFileReadResponse,
  WorkspaceFileSearchResponse,
  WorkspaceChangedFilesResponse,
  WorkspaceFileDiffResponse,
} from "@agework/shared/api";
import type {
  RuntimeInstanceRef,
  RuntimeLaunchContext,
} from "@agework/providers";
import type { RuntimeTunnelHandler } from "../gateway/runtime-tunnel.handler";
import type { Runtime } from "../runtime.types";

/** stop/destroy 是快速的载体收尾动作,给它固定的、不接入 admin 设置的超时——
 *  不是需要运营调的旋钮,调大没意义(载体真死了永远等不到回应)。 */
const TEARDOWN_RPC_TIMEOUT_MS = 30_000;

/**
 * `Runtime` 接口的 Registered 实现:把 start/stop/destroy 转成隧道 RPC,发给
 * `runtimeId` 对应的 agework-runtime/manager。每次 `runtimeFor(runtimeId)` 都
 * 是新建的轻量实例(不持有连接本身,连接归 RuntimeTunnelHandler 管),构造零开销。
 *
 * onExit 本地专属(见 Runtime.start 文档)——这里不接收该参数,远程 worker 死活
 * 走 server 心跳 fence 兜底,不经隧道回传。
 */
export class RemoteRuntime implements Runtime {
  constructor(
    private readonly runtimeId: string,
    private readonly tunnel: RuntimeTunnelHandler,
    private readonly launchTimeoutMs: number
  ) {}

  async start(
    ctx: RuntimeLaunchContext
  ): Promise<{ runtimeInstanceId: string }> {
    const params: RuntimeLaunchRpcParams = {
      ownerId: ctx.ownerId,
      workspaceId: ctx.workspaceId,
      runId: ctx.runId,
      placement: ctx.placement,
      workerEnv: ctx.workerEnv,
      expectedRuntimeInstanceId: ctx.expectedRuntimeInstanceId ?? null,
    };
    return this.tunnel.sendRequest<RuntimeLaunchRpcResult>(
      this.runtimeId,
      this.request("runtime.launch", params),
      this.launchTimeoutMs
    );
  }

  async stop(ref: RuntimeInstanceRef): Promise<void> {
    await this.sendInstanceAction("runtime.stop", ref);
  }

  async destroy(ref: RuntimeInstanceRef): Promise<void> {
    await this.sendInstanceAction("runtime.destroy", ref);
  }

  /** 通过隧道发 detect-env RPC,远程 manager 重检后返回 envConfig。 */
  async detectEnv(): Promise<RuntimeEnvConfig> {
    const result = await this.tunnel.sendRequest<{ envConfig: RuntimeEnvConfig }>(
      this.runtimeId,
      this.request("runtime.detect-env", {}),
      this.launchTimeoutMs
    );
    return result.envConfig;
  }

  /** 通过隧道发 list-dir RPC,列出远程机器上 path 下的子目录。 */
  async listDirectory(
    path?: string
  ): Promise<{ path: string; entries: string[] }> {
    const params: RuntimeListDirRpcParams = { path };
    return this.tunnel.sendRequest<RuntimeListDirRpcResult>(
      this.runtimeId,
      this.request("runtime.list-dir", params),
      this.launchTimeoutMs
    );
  }

  /** 通过隧道发 create-dir RPC,在远程机器上新建目录。 */
  async createDirectory(path: string): Promise<{ path: string }> {
    const params: RuntimeCreateDirRpcParams = { path };
    return this.tunnel.sendRequest<RuntimeCreateDirRpcResult>(
      this.runtimeId,
      this.request("runtime.create-dir", params),
      this.launchTimeoutMs
    );
  }

  /** 通过隧道发 list-files RPC,列出远程机器上 rootPath 下 relativePath 的文件列表。 */
  async listFiles(
    rootPath: string,
    relativePath: string
  ): Promise<WorkspaceFileListResponse> {
    const params: RuntimeListFilesRpcParams = { rootPath, path: relativePath };
    return this.tunnel.sendRequest<RuntimeListFilesRpcResult>(
      this.runtimeId,
      this.request("runtime.list-files", params),
      this.launchTimeoutMs
    );
  }

  /** 通过隧道发 read-file RPC,读取远程机器上 rootPath 下 relativePath 的文件内容。 */
  async readFile(
    rootPath: string,
    relativePath: string
  ): Promise<WorkspaceFileReadResponse> {
    const params: RuntimeReadFileRpcParams = { rootPath, path: relativePath };
    return this.tunnel.sendRequest<RuntimeReadFileRpcResult>(
      this.runtimeId,
      this.request("runtime.read-file", params),
      this.launchTimeoutMs
    );
  }

  /** 通过隧道发 list-changed-files RPC,列出远程机器上 rootPath 下相对 HEAD 的变更文件。 */
  async listChangedFiles(
    rootPath: string
  ): Promise<WorkspaceChangedFilesResponse> {
    const params: RuntimeListChangedFilesRpcParams = { rootPath };
    return this.tunnel.sendRequest<RuntimeListChangedFilesRpcResult>(
      this.runtimeId,
      this.request("runtime.list-changed-files", params),
      this.launchTimeoutMs
    );
  }

  /** 通过隧道发 search-files RPC,列出远程机器上 rootPath 下所有文件相对路径。 */
  async searchFiles(
    rootPath: string
  ): Promise<WorkspaceFileSearchResponse> {
    const params: RuntimeSearchFilesRpcParams = { rootPath };
    return this.tunnel.sendRequest<RuntimeSearchFilesRpcResult>(
      this.runtimeId,
      this.request("runtime.search-files", params),
      this.launchTimeoutMs
    );
  }

  /** 通过隧道发 read-file-diff RPC,读取远程机器上 rootPath 下 relativePath 的 diff。 */
  async readFileDiff(
    rootPath: string,
    relativePath: string
  ): Promise<WorkspaceFileDiffResponse> {
    const params: RuntimeReadFileDiffRpcParams = { rootPath, path: relativePath };
    return this.tunnel.sendRequest<RuntimeReadFileDiffRpcResult>(
      this.runtimeId,
      this.request("runtime.read-file-diff", params),
      this.launchTimeoutMs
    );
  }

  private async sendInstanceAction(
    method: "runtime.stop" | "runtime.destroy",
    ref: RuntimeInstanceRef
  ): Promise<void> {
    const params: RuntimeInstanceRefRpcParams = {
      ownerId: ref.ownerId,
      workerId: ref.workerId,
      runtimeInstanceId: ref.runtimeInstanceId,
      isolationScope: ref.isolationScope,
    };
    await this.tunnel.sendRequest(
      this.runtimeId,
      this.request(method, params),
      TEARDOWN_RPC_TIMEOUT_MS
    );
  }

  private request(
    method: RuntimeTunnelRpcRequest["method"],
    params: RuntimeTunnelRpcRequest["params"]
  ): RuntimeTunnelRpcRequest {
    return {
      jsonrpc: JSON_RPC_VERSION,
      id: randomUUID(),
      method,
      params,
    } as RuntimeTunnelRpcRequest;
  }
}
