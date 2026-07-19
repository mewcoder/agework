import { WebSocket, type RawData } from "ws";
import { randomUUID } from "node:crypto";
import {
  RUNTIME_HOST_TUNNEL_PROTOCOL_VERSION,
  RUNTIME_TUNNEL_CLOSE_INCOMPATIBLE,
  RUNTIME_TUNNEL_CLOSE_GONE,
  type HostTunnelRegisterMessage,
  type HostTunnelAllRpcRequest,
  type RuntimeHostContract,
  type HostListRunsRpcResult,
  type HostListWorkersRpcResult,
  type InstallCliResult,
  type RuntimeCapabilities,
  type WorkerScope,
} from "@agework/shared/protocol";
import { rpcError, rpcSuccess } from "@agework/shared/protocol/rpc";
import {
  isHostTunnelHostRpcRequest,
  isHostTunnelRegisteredMessage,
  isHostTunnelServerNotification,
  isWireMessageType,
} from "@agework/shared/protocol/wire";
import { AGEWORK_VERSION } from "@agework/shared";
import type { RuntimeEnvConfig } from "@agework/shared/api";
import type { RegisteredRuntimeHostConfig, RuntimeType } from "./config.js";
import { detectEnvConfig } from "@agework/shared/cli";
import type {
  DirectoryListing,
  HostCapabilityStatus,
} from "@agework/shared/protocol";
import type {
  WorkspaceFileListResponse,
  WorkspaceFileReadResponse,
  WorkspaceFileSearchResponse,
  WorkspaceChangedFilesResponse,
  WorkspaceFileDiffResponse,
} from "@agework/shared/api";
import { TunnelUpstream } from "./tunnel-upstream.js";

/** 按 runtimeTypes 构建能力矩阵条目(scope 表 + 各类型的可用性)。 */
export function buildCapabilities(
  runtimeTypes: RuntimeType[],
  availabilityOf: (runtimeType: RuntimeType) => {
    available: boolean;
    reason?: string;
  },
  pluginScopesOf: (
    runtimeType: RuntimeType
  ) => readonly WorkerScope[] | undefined = () => undefined,
  displayNameOf: (runtimeType: RuntimeType) => string | undefined = () =>
    undefined
): RuntimeCapabilities {
  return Object.fromEntries(
    runtimeTypes.map((runtimeType) => [
      runtimeType,
      {
        ...availabilityOf(runtimeType),
        displayName:
          displayNameOf(runtimeType) ??
          (runtimeType === "native" ? "Native" : runtimeType),
        scopes:
          runtimeType === "native"
            ? ["workspace"]
            : [...(pluginScopesOf(runtimeType) ?? ["user", "workspace"])],
      },
    ])
  );
}

export function log(message: string, level: "info" | "error" = "info"): void {
  const line = `[agework-runtime] ${new Date().toISOString()} ${message}`;
  if (level === "error") console.error(line);
  else console.log(line);
}

export interface TunnelClientOptions {
  config: RegisteredRuntimeHostConfig;
  /** register 上报的能力矩阵(每种 runtimeType 的可用性 + scope)。传 getter 时
   *  每次 register(含重连)取当前矩阵——矩阵可动态刷新,重连上报最新现场。
   *  未提供时按 config.runtimeTypes 全部可用构建(测试便利)。 */
  capabilities?: RuntimeCapabilities | (() => RuntimeCapabilities);
  /** Host 控制面契约；所有 RPC 都委托给它。 */
  hostContract: RuntimeHostContract;
  /** Phase 2: Host 上行通知的隧道实现,连接建立/断开时由 TunnelClient 接线。 */
  tunnelUpstream?: TunnelUpstream;
  /** Runtime Host 已被 server 删除(收到 4410):调用方应退出进程,不再重连。 */
  onGone: () => void;
  /** 协议明确不兼容(收到/触发 4411):调用方应退出并升级,不再重连。 */
  onIncompatible?: (reason: string) => void;
  /** 重连退避起始值,仅测试用;默认 1s,翻倍封顶 30s。 */
  reconnectBaseDelayMs?: number;
}

/**
 * 控制隧道客户端:出站 WS 连 server,注册/上报能力/心跳/断线重连,一条连接一个状态机;
 * 同一条连接上还接收 server 下发的 host.* JSON-RPC 请求并回一个 RpcResponse。
 */
export class TunnelClient {
  private ws?: WebSocket;
  /** server 在 registered 回执里分配的 host id；注册前为空串。 */
  private runtimeHostId = "";
  private heartbeatTimer?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private readonly baseDelayMs: number;
  private reconnectDelayMs: number;
  private stopped = false;
  /** Host 进程实例标识:构造(进程启动)时生成一次,断线重连沿用同值;
   *  进程重启即新实例、新值,Server 据此判定旧 run 已无续传可能并判死。 */
  private readonly processInstanceId = randomUUID();

  constructor(private readonly options: TunnelClientOptions) {
    this.baseDelayMs = options.reconnectBaseDelayMs ?? 1000;
    this.reconnectDelayMs = this.baseDelayMs;
  }

  start(): void {
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    // 关连接前先告别:让 server 立即收尾本 Host 上的 run,不必等离线兜底 sweep。
    // best-effort——只在连接就绪时发得出;发不出就退回 server 侧超时判死。
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "shutdown" }));
    }
    this.ws?.close(1000, "registered runtime host shutting down");
  }

  private tunnelUrl(): string {
    const base = this.options.config.serverBaseUrl;
    return `${base.replace(/^http/, "ws")}/runtime-hosts/tunnel`;
  }

  private connect(): void {
    if (this.stopped) return;
    const ws = new WebSocket(this.tunnelUrl(), {
      headers: { authorization: `Bearer ${this.options.config.token}` },
    });
    this.ws = ws;
    ws.on("open", () => {
      // 上行通道在收到 registered(带会话 epoch)后才接线,这个窗口内的
      // 通知只入 TunnelUpstream 缓冲,注册完成后按 seq 补发。
      const envConfig = detectEnvConfig();
      const register: HostTunnelRegisterMessage = {
        type: "register",
        protocolVersion: RUNTIME_HOST_TUNNEL_PROTOCOL_VERSION,
        processInstanceId: this.processInstanceId,
        capabilities:
          (typeof this.options.capabilities === "function"
            ? this.options.capabilities()
            : this.options.capabilities) ??
          buildCapabilities(this.options.config.runtimeTypes, () => ({
            available: true,
          })),
        version: AGEWORK_VERSION,
        envConfig,
      };
      ws.send(JSON.stringify(register));
    });
    ws.on("message", (data) => {
      this.onMessage(ws, data);
    });
    ws.on("error", (err) => {
      log(`tunnel error: ${err.message}`, "error");
    });
    ws.on("close", (code) => {
      this.onClose(code);
    });
  }

  private onMessage(ws: WebSocket, data: RawData): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        Buffer.isBuffer(data) ? data.toString("utf8") : String(data)
      );
    } catch {
      log("malformed tunnel message from server", "error");
      ws.close(1008, "malformed tunnel message");
      return;
    }

    if (isHostTunnelHostRpcRequest(parsed)) {
      this.onRpcRequest(ws, parsed);
      return;
    }

    // Phase 2: server 的单向通知——ACK 水位清缓冲 / run 终结清状态
    if (isHostTunnelServerNotification(parsed)) {
      if (parsed.method === "host.upstreamAck") {
        const { seq } = parsed.params;
        this.options.tunnelUpstream?.onAck(seq);
      } else if (parsed.method === "host.releaseRun") {
        this.options.hostContract.releaseRun(parsed.params);
      }
      return;
    }

    if (isWireMessageType(parsed, "registered")) {
      if (parsed.protocolVersion !== RUNTIME_HOST_TUNNEL_PROTOCOL_VERSION) {
        log(
          `server tunnel protocol ${String(parsed.protocolVersion)} is incompatible with host protocol ${RUNTIME_HOST_TUNNEL_PROTOCOL_VERSION}`,
          "error"
        );
        ws.close(
          RUNTIME_TUNNEL_CLOSE_INCOMPATIBLE,
          "incompatible tunnel protocol"
        );
        return;
      }
      if (!isHostTunnelRegisteredMessage(parsed)) {
        log("invalid registered handshake from server", "error");
        ws.close(1008, "invalid registered handshake");
        return;
      }
      this.runtimeHostId = parsed.runtimeHostId;
      log(
        `registered as runtime host ${parsed.runtimeHostId} (${this.options.config.runtimeTypes.join(",")})`
      );
      this.reconnectDelayMs = this.baseDelayMs; // 注册成功即重置退避
      // Phase 2: 注册完成才接线上行通道(绑定会话 epoch),并补发未 ACK 通知
      this.options.tunnelUpstream?.setSession(ws, parsed.epoch);
      this.scheduleHeartbeat(ws, parsed.heartbeatIntervalSeconds);
      return;
    }

    log("invalid tunnel message from server", "error");
    ws.close(1008, "invalid tunnel message");
  }

  private onRpcRequest(ws: WebSocket, request: HostTunnelAllRpcRequest): void {
    const handled = this.dispatch(request).then(
      (result) => rpcSuccess(request.id, result ?? null),
      (err: unknown) =>
        rpcError(request.id, {
          code: -32000,
          message: err instanceof Error ? err.message : String(err),
        })
    );
    void handled.then((response) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(response));
      }
    });
  }

  private async dispatch(
    request: HostTunnelAllRpcRequest
  ): Promise<
    | { runtimeInstanceId: string }
    | { envConfig: RuntimeEnvConfig }
    | { path: string; entries: string[] }
    | { path: string }
    | WorkspaceFileListResponse
    | WorkspaceFileReadResponse
    | WorkspaceFileSearchResponse
    | WorkspaceChangedFilesResponse
    | WorkspaceFileDiffResponse
    | HostListRunsRpcResult
    | HostListWorkersRpcResult
    | HostCapabilityStatus
    | DirectoryListing
    | InstallCliResult
    | void
  > {
    const hostContract = this.options.hostContract;
    switch (request.method) {
      case "host.submitRun":
        await hostContract.submitRun(request.params);
        return;
      case "host.command":
        await hostContract.command(request.params);
        return;
      case "host.releaseOwner":
        await hostContract.releaseOwner(request.params);
        return;
      case "host.detectEnv":
        return hostContract.detectEnv(request.params.runtimeHostId);
      case "host.listDirectory":
        return hostContract.listDirectory(request.params);
      case "host.createDirectory":
        await hostContract.createDirectory(request.params);
        return;
      case "host.listFiles":
        return hostContract.listFiles(request.params);
      case "host.readFile":
        return hostContract.readFile(request.params);
      case "host.readFileDiff":
        return hostContract.readFileDiff(request.params);
      case "host.searchFiles":
        return hostContract.searchFiles(request.params);
      case "host.listChangedFiles":
        return hostContract.listChangedFiles(request.params);
      case "host.listRuns":
        return { runIds: await hostContract.listRunIds(this.runtimeHostId) };
      case "host.listWorkers":
        const workers = await hostContract.listWorkers();
        return { workers };
      case "host.stopWorker":
        return await hostContract.stopWorker(request.params);
      case "host.installCli":
        return hostContract.installCli(request.params);
    }
  }

  private scheduleHeartbeat(ws: WebSocket, intervalSeconds: number): void {
    this.clearHeartbeat();
    const intervalMs = Math.max(50, intervalSeconds * 1000);
    this.heartbeatTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "heartbeat" }));
      }
    }, intervalMs);
    // 心跳期间连接本身持有事件循环,timer 不需要额外持有
    this.heartbeatTimer.unref();
  }

  private onClose(code: number): void {
    this.clearHeartbeat();
    // Phase 2: 断开上行通知通道(缓冲保留,重连注册后补发)
    this.options.tunnelUpstream?.clearSocket();
    if (this.stopped) return;
    if (code === RUNTIME_TUNNEL_CLOSE_GONE) {
      log("runtime host deleted on server (4410), exiting", "error");
      this.stopped = true;
      this.options.onGone();
      return;
    }
    if (code === RUNTIME_TUNNEL_CLOSE_INCOMPATIBLE) {
      const reason = `tunnel protocol incompatible (code ${RUNTIME_TUNNEL_CLOSE_INCOMPATIBLE}); upgrade server and runtime host together`;
      log(reason, "error");
      this.stopped = true;
      this.options.onIncompatible?.(reason);
      return;
    }
    const ceiling = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 30_000);
    // 加抖动:Server 重启后大量 Host 不要锁步同时重连(惊群),
    // 在当前退避档的 50%~100% 之间随机取一个延迟。
    const delay = Math.round(ceiling / 2 + Math.random() * (ceiling / 2));
    log(`tunnel closed (code ${code}), reconnecting in ${delay}ms`);
    // 注意:重连等待期间这个 timer 是进程唯一的存活来源,不能 unref
    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private clearTimers(): void {
    this.clearHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }
}
