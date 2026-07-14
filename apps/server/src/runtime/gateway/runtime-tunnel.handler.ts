import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket, type RawData } from "ws";
import {
  RUNTIME_TUNNEL_CLOSE_GONE,
  normalizeRuntimeCapabilities,
  type RuntimeTunnelClientMessage,
  type RuntimeTunnelRegisteredMessage,
  type RuntimeTunnelAllRpcRequest,
  type RuntimeTunnelHostNotification,
  type HostUpstreamNotification,
  type HostUpstreamEnvelope,
} from "@agework/shared/protocol";
import {
  isRpcResponse,
  isRpcNotification,
  type RpcId,
  type RpcResponse,
} from "@agework/shared/protocol/rpc";
import { getApiContext, ConfigService } from "../../config/config.service";
import { resolveApiBasePath } from "../../common/api-path";
import { RuntimeRepository } from "../runtime.repository";
import { AGEWORK_VERSION } from "@agework/shared";

/** 隧道 WS 关闭码:同名 runtime 的新连接顶掉旧连接。 */
const CLOSE_REPLACED = 4409;

type PendingRequest = {
  runtimeHostId: string;
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
};

/**
 * Registered Runtime 控制隧道的 server 端:接受 agework-runtime/manager 的出站 WS,
 * 配对 token(sha256 比对)鉴权,处理 register/heartbeat,断连即标 offline;同一条
 * 连接上还承载 host.* JSON-RPC 请求/响应。server 永不反连 Host——这里只被动收连接、
 * 主动发的只有已建连上的 RPC 请求。
 */
@Injectable()
export class RuntimeTunnelHandler
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(RuntimeTunnelHandler.name);
  private readonly tunnelPath = `${resolveApiBasePath(getApiContext())}/runtimes/tunnel`;
  private readonly connections = new Map<string, WebSocket>();
  private readonly pending = new Map<RpcId, PendingRequest>();
  /** Phase 2: host.upstream 通知回调，由 RuntimeHostAdapter 注册。
   *  返回 Promise 时按连接串行 await(保事件顺序),处理完成后回 ACK。 */
  private upstreamHandler?: (
    runtimeHostId: string,
    notification: HostUpstreamNotification
  ) => Promise<void> | void;
  /** Phase 2: 每个 runtime 的隧道会话状态。epoch 每次 register 递增,
   *  非当前 epoch 的上行信封丢弃(防脑裂);chain 串行化上行处理保事件顺序。 */
  private readonly hostSessions = new Map<
    string,
    { epoch: number; chain: Promise<void> }
  >();
  private wss?: WebSocketServer;
  private httpServer?: {
    on: (event: string, listener: typeof this.onUpgrade) => void;
    off: (event: string, listener: typeof this.onUpgrade) => void;
  };

  constructor(
    private readonly repository: RuntimeRepository,
    private readonly configService: ConfigService,
    private readonly httpAdapterHost: HttpAdapterHost
  ) {}

  onApplicationBootstrap(): void {
    const httpServer = this.httpAdapterHost.httpAdapter?.getHttpServer() as
      | typeof this.httpServer
      | undefined;
    if (!httpServer) return; // 测试环境等无 HTTP server 场景
    this.wss = new WebSocketServer({ noServer: true });
    this.httpServer = httpServer;
    httpServer.on("upgrade", this.onUpgrade);
  }

  onApplicationShutdown(): void {
    this.httpServer?.off("upgrade", this.onUpgrade);
    for (const socket of this.connections.values()) {
      socket.close(1001, "server shutting down");
    }
    this.connections.clear();
    this.wss?.close();
  }

  /** 删除 runtime 后踢掉在线连接(manager 收 4410 应退出,不再重连)。 */
  closeConnection(runtimeHostId: string): void {
    const socket = this.connections.get(runtimeHostId);
    if (!socket) return;
    this.connections.delete(runtimeHostId);
    socket.close(RUNTIME_TUNNEL_CLOSE_GONE, "runtime deleted");
  }

  /** runtime 是否在线（隧道连接存在）。 */
  isConnected(runtimeHostId: string): boolean {
    return this.connections.has(runtimeHostId);
  }

  /** Phase 2: 列出所有在线（隧道连接存在）的 runtime id。 */
  listConnected(): string[] {
    return [...this.connections.keys()];
  }

  /** Phase 2: 注册 host.upstream 通知回调。 */
  setUpstreamHandler(
    handler: (
      runtimeHostId: string,
      notification: HostUpstreamNotification
    ) => Promise<void> | void
  ): void {
    this.upstreamHandler = handler;
  }

  /** 向目标 runtimeHostId 发一条单向通知(不等回应,不在线即丢弃,best-effort)。 */
  sendNotification(
    runtimeHostId: string,
    notification: RuntimeTunnelHostNotification
  ): void {
    const socket = this.connections.get(runtimeHostId);
    if (!socket) return;
    socket.send(JSON.stringify(notification));
  }

  /** 向目标 runtimeHostId 发一次 RPC（launch/stop/destroy/host.*），等它回应或超时。
   *  Phase 2 扩展：接受 RuntimeTunnelAllRpcRequest，包含 host.submitRun/command/releaseOwner。 */
  sendRequest<Result>(
    runtimeHostId: string,
    request: RuntimeTunnelAllRpcRequest,
    timeoutMs: number
  ): Promise<Result> {
    const socket = this.connections.get(runtimeHostId);
    if (!socket) {
      return Promise.reject(new Error(`runtime ${runtimeHostId} is not connected`));
    }
    return new Promise<Result>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.id);
        reject(
          new Error(
            `runtime ${runtimeHostId} did not respond to ${request.method} within ${timeoutMs}ms`
          )
        );
      }, timeoutMs);
      this.pending.set(request.id, {
        runtimeHostId,
        resolve: resolve,
        reject,
        timer,
      });
      socket.send(JSON.stringify(request));
    });
  }

  private readonly onUpgrade = (
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer
  ): void => {
    const pathname = new URL(req.url ?? "/", "http://placeholder").pathname;
    if (pathname !== this.tunnelPath) {
      // server 上没有其它 WS 端点,非隧道路径的 upgrade 一律拒绝
      socket.destroy();
      return;
    }
    void this.authorize(req)
      .then((runtimeHostId) => {
        if (!runtimeHostId) {
          socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
          socket.destroy();
          return;
        }
        this.wss?.handleUpgrade(req, socket, head, (ws) => {
          this.attach(runtimeHostId, ws);
        });
      })
      .catch((err: unknown) => {
        this.logger.warn(
          `tunnel upgrade failed: ${err instanceof Error ? err.message : String(err)}`
        );
        socket.destroy();
      });
  };

  private async authorize(req: IncomingMessage): Promise<string | null> {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) return null;
    const token = header.slice("Bearer ".length).trim();
    if (!token) return null;
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const runtime = await this.repository.findByTokenHash(tokenHash);
    return runtime?.id ?? null;
  }

  private attach(runtimeHostId: string, ws: WebSocket): void {
    this.connections.get(runtimeHostId)?.close(CLOSE_REPLACED, "replaced");
    this.connections.set(runtimeHostId, ws);

    ws.on("message", (data: RawData) => {
      void this.onMessage(runtimeHostId, ws, data).catch((err: unknown) => {
        this.logger.warn(
          `tunnel message from runtime ${runtimeHostId} failed: ${err instanceof Error ? err.message : String(err)}`
        );
      });
    });
    ws.on("close", () => {
      if (this.connections.get(runtimeHostId) !== ws) return; // 已被新连接顶掉
      this.connections.delete(runtimeHostId);
      this.rejectPendingFor(runtimeHostId, "connection closed");
      // builtin Host 在 server 进程内，不会建立隧道；所有隧道连接都属于
      // registered Host，断连即标记离线。
      void this.repository.markOffline(runtimeHostId).catch((err: unknown) => {
        this.logger.warn(
          `mark runtime ${runtimeHostId} offline failed: ${err instanceof Error ? err.message : String(err)}`
        );
      });
    });
  }

  /** 连接断开时,这台 runtime 上还没等到回应的 RPC 永远等不到了,主动拒绝掉。 */
  private rejectPendingFor(runtimeHostId: string, reason: string): void {
    for (const [id, entry] of this.pending) {
      if (entry.runtimeHostId !== runtimeHostId) continue;
      clearTimeout(entry.timer);
      this.pending.delete(id);
      entry.reject(new Error(`runtime ${runtimeHostId} ${reason}`));
    }
  }

  private async onMessage(
    runtimeHostId: string,
    ws: WebSocket,
    data: RawData
  ): Promise<void> {
    const text = Buffer.isBuffer(data)
      ? data.toString("utf8")
      : Array.isArray(data)
        ? Buffer.concat(data).toString("utf8")
        : Buffer.from(data).toString("utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.logger.warn(`runtime ${runtimeHostId} sent malformed tunnel message`);
      return;
    }

    if (isRpcResponse(parsed)) {
      this.onRpcResponse(runtimeHostId, parsed);
      return;
    }

    // Phase 2: host.upstream 通知（Host → server，单向,带 seq/epoch 信封）
    if (isRpcNotification(parsed)) {
      if (parsed.method === "host.upstream") {
        this.onUpstreamEnvelope(
          runtimeHostId,
          ws,
          parsed.params as HostUpstreamEnvelope
        );
      }
      return;
    }

    const message = parsed as RuntimeTunnelClientMessage;
    switch (message.type) {
      case "register": {
        const capabilities = normalizeRuntimeCapabilities(message.capabilities);
        if (Object.keys(capabilities).length === 0) {
          this.logger.warn(
            `runtime ${runtimeHostId} registered without a valid capability matrix`
          );
          ws.close(1008, "invalid capability matrix");
          return;
        }
        const found = await this.repository.markRegistered(
          runtimeHostId,
          capabilities,
          message.envConfig
        );
        if (!found) {
          ws.close(RUNTIME_TUNNEL_CLOSE_GONE, "runtime deleted");
          return;
        }
        if (message.version && message.version !== AGEWORK_VERSION) {
          this.logger.warn(
            `runtime ${runtimeHostId} version mismatch: manager=${message.version} server=${AGEWORK_VERSION} (允许接入,Registered 远程 manager 单独构建后可能与 server 漂移)`
          );
        }
        const reply: RuntimeTunnelRegisteredMessage = {
          type: "registered",
          runtimeHostId,
          heartbeatIntervalSeconds: this.heartbeatIntervalSeconds(),
          // Phase 2: 每次 register 递增会话 epoch,Host 盖在上行信封里,
          // 被顶掉的旧连接残留消息按 epoch 丢弃(防脑裂)。
          epoch: this.nextEpoch(runtimeHostId),
        };
        ws.send(JSON.stringify(reply));
        return;
      }
      case "heartbeat": {
        const found = await this.repository.touchHeartbeat(runtimeHostId);
        if (!found) {
          ws.close(RUNTIME_TUNNEL_CLOSE_GONE, "runtime deleted");
        }
        return;
      }
      default:
        this.logger.warn(
          `runtime ${runtimeHostId} sent unknown tunnel message type`
        );
    }
  }

  /** register 时递增该 runtime 的隧道会话 epoch 并返回。 */
  private nextEpoch(runtimeHostId: string): number {
    const session = this.hostSessions.get(runtimeHostId);
    const epoch = (session?.epoch ?? 0) + 1;
    this.hostSessions.set(runtimeHostId, {
      epoch,
      chain: session?.chain ?? Promise.resolve(),
    });
    return epoch;
  }

  /**
   * host.upstream 信封处理:
   * 1. 只认当前连接 + 当前 epoch(被顶掉的旧连接残留一律丢弃);
   * 2. 按 runtime 串行 await 处理(保事件顺序,处理失败记日志不中断——
   *    与 Event 纪律一致,ACK 只保证传输不丢,处理仍是 best-effort);
   * 3. 处理完成回累计 ACK 水位,Host 收到后清缓冲。
   */
  private onUpstreamEnvelope(
    runtimeHostId: string,
    ws: WebSocket,
    envelope: HostUpstreamEnvelope
  ): void {
    const session = this.hostSessions.get(runtimeHostId);
    if (this.connections.get(runtimeHostId) !== ws) {
      this.logger.warn(
        `dropped upstream from a replaced connection of runtime ${runtimeHostId}`
      );
      return;
    }
    // 双栈兼容:旧版 Host 直接发裸 notification(无 seq/epoch 信封),
    // 照旧 best-effort 处理、不回 ACK。
    if (envelope.notification === undefined) {
      const legacy = envelope as unknown as HostUpstreamNotification;
      if ("kind" in legacy) {
        void Promise.resolve(this.upstreamHandler?.(runtimeHostId, legacy)).catch(
          (err: unknown) => {
            this.logger.warn(
              `legacy upstream handler failed for runtime ${runtimeHostId}: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        );
      }
      return;
    }
    if (envelope.epoch !== undefined && envelope.epoch !== session?.epoch) {
      this.logger.warn(
        `dropped stale-epoch upstream from runtime ${runtimeHostId}: epoch=${envelope.epoch} current=${session?.epoch ?? "none"}`
      );
      return;
    }
    if (!session) return; // 未注册就发上行:异常客户端,丢弃
    session.chain = session.chain
      .then(async () => {
        try {
          await this.upstreamHandler?.(runtimeHostId, envelope.notification);
        } catch (err) {
          this.logger.warn(
            `upstream handler failed for runtime ${runtimeHostId} seq=${envelope.seq}: ${err instanceof Error ? err.message : String(err)}`
          );
        }
        this.sendUpstreamAck(runtimeHostId, ws, envelope.seq);
      })
      .catch(() => {});
  }

  private sendUpstreamAck(runtimeHostId: string, ws: WebSocket, seq: number): void {
    if (ws.readyState !== ws.OPEN) return;
    if (this.connections.get(runtimeHostId) !== ws) return;
    ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "host.upstreamAck",
        params: { seq },
      })
    );
  }

  private onRpcResponse(runtimeHostId: string, response: RpcResponse): void {
    if (response.id === null) {
      this.logger.warn(
        `runtime ${runtimeHostId} sent an RPC response with id=null`
      );
      return;
    }
    const entry = this.pending.get(response.id);
    if (!entry) {
      this.logger.warn(
        `runtime ${runtimeHostId} sent an RPC response for unknown request ${String(response.id)}`
      );
      return;
    }
    if (entry.runtimeHostId !== runtimeHostId) {
      // 防御:响应必须来自当初收到请求的那条连接,不能拿别人的 id 解掉本请求
      this.logger.warn(
        `runtime ${runtimeHostId} sent an RPC response for a request owned by ${entry.runtimeHostId}`
      );
      return;
    }
    clearTimeout(entry.timer);
    this.pending.delete(response.id);
    if ("result" in response) {
      entry.resolve(response.result);
    } else {
      entry.reject(new Error(response.error.message));
    }
  }

  private heartbeatIntervalSeconds(): number {
    // 上报节奏取判死窗口的 1/3,保证超时前至少两次心跳机会
    return Math.max(
      5,
      Math.floor(this.configService.getHeartbeatTimeoutSeconds() / 3)
    );
  }
}
