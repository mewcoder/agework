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
  RuntimeTunnelRpcRequest,
} from "@agework/shared/protocol";
import type { RuntimeEnvConfig } from "@agework/shared/api";
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

  private async sendInstanceAction(
    method: "runtime.stop" | "runtime.destroy",
    ref: RuntimeInstanceRef
  ): Promise<void> {
    const params: RuntimeInstanceRefRpcParams = {
      ownerId: ref.ownerId,
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
