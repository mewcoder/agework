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
  type RuntimeTunnelClientMessage,
  type RuntimeTunnelRegisteredMessage,
  type RuntimeTunnelRpcRequest,
} from "@agework/shared/protocol";
import {
  isRpcResponse,
  type RpcId,
  type RpcResponse,
} from "@agework/shared/protocol/rpc";
import { getApiContext, ConfigService } from "../../config/config.service";
import { resolveApiBasePath } from "../../common/path.util";
import { RuntimeRepository } from "../runtime.repository";

/** 隧道 WS 关闭码:同名 runtime 的新连接顶掉旧连接。 */
const CLOSE_REPLACED = 4409;

type PendingRequest = {
  runtimeId: string;
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
};

/**
 * Registered Runtime 控制隧道的 server 端:接受 agework-runtime/manager 的出站 WS,
 * 配对 token(sha256 比对)鉴权,处理 register/heartbeat,断连即标 offline;同一条
 * 连接上还承载 launch/stop/destroy 的 JSON-RPC 请求/响应(sendRequest,= RemoteRuntime
 * 的后端)。server 永不反连 runtime——这里只被动收连接、主动发的只有已建连上的 RPC 请求。
 */
@Injectable()
export class RuntimeTunnelHandler
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(RuntimeTunnelHandler.name);
  private readonly tunnelPath = `${resolveApiBasePath(getApiContext())}/runtimes/tunnel`;
  private readonly connections = new Map<string, WebSocket>();
  private readonly pending = new Map<RpcId, PendingRequest>();
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
  closeConnection(runtimeId: string): void {
    const socket = this.connections.get(runtimeId);
    if (!socket) return;
    this.connections.delete(runtimeId);
    socket.close(RUNTIME_TUNNEL_CLOSE_GONE, "runtime deleted");
  }

  /** 向目标 runtimeId 发一次 launch/stop/destroy RPC,等它回应或超时。
   *  这是 RemoteRuntime 的唯一后端:RemoteRuntime 只组包、这里管连接与关联。 */
  sendRequest<Result>(
    runtimeId: string,
    request: RuntimeTunnelRpcRequest,
    timeoutMs: number
  ): Promise<Result> {
    const socket = this.connections.get(runtimeId);
    if (!socket) {
      return Promise.reject(new Error(`runtime ${runtimeId} is not connected`));
    }
    return new Promise<Result>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.id);
        reject(
          new Error(
            `runtime ${runtimeId} did not respond to ${request.method} within ${timeoutMs}ms`
          )
        );
      }, timeoutMs);
      this.pending.set(request.id, {
        runtimeId,
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
      .then((runtimeId) => {
        if (!runtimeId) {
          socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
          socket.destroy();
          return;
        }
        this.wss?.handleUpgrade(req, socket, head, (ws) => {
          this.attach(runtimeId, ws);
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

  private attach(runtimeId: string, ws: WebSocket): void {
    this.connections.get(runtimeId)?.close(CLOSE_REPLACED, "replaced");
    this.connections.set(runtimeId, ws);

    ws.on("message", (data: RawData) => {
      void this.onMessage(runtimeId, ws, data).catch((err: unknown) => {
        this.logger.warn(
          `tunnel message from runtime ${runtimeId} failed: ${err instanceof Error ? err.message : String(err)}`
        );
      });
    });
    ws.on("close", () => {
      if (this.connections.get(runtimeId) !== ws) return; // 已被新连接顶掉
      this.connections.delete(runtimeId);
      this.rejectPendingFor(runtimeId, "connection closed");
      void this.repository.markOffline(runtimeId).catch((err: unknown) => {
        this.logger.warn(
          `mark runtime ${runtimeId} offline failed: ${err instanceof Error ? err.message : String(err)}`
        );
      });
    });
  }

  /** 连接断开时,这台 runtime 上还没等到回应的 RPC 永远等不到了,主动拒绝掉。 */
  private rejectPendingFor(runtimeId: string, reason: string): void {
    for (const [id, entry] of this.pending) {
      if (entry.runtimeId !== runtimeId) continue;
      clearTimeout(entry.timer);
      this.pending.delete(id);
      entry.reject(new Error(`runtime ${runtimeId} ${reason}`));
    }
  }

  private async onMessage(
    runtimeId: string,
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
      this.logger.warn(`runtime ${runtimeId} sent malformed tunnel message`);
      return;
    }

    if (isRpcResponse(parsed)) {
      this.onRpcResponse(runtimeId, parsed);
      return;
    }

    const message = parsed as RuntimeTunnelClientMessage;
    switch (message.type) {
      case "register": {
        const found = await this.repository.markRegistered(
          runtimeId,
          message.runtimeType,
          message.capabilities
        );
        if (!found) {
          ws.close(RUNTIME_TUNNEL_CLOSE_GONE, "runtime deleted");
          return;
        }
        const reply: RuntimeTunnelRegisteredMessage = {
          type: "registered",
          runtimeId,
          heartbeatIntervalSeconds: this.heartbeatIntervalSeconds(),
        };
        ws.send(JSON.stringify(reply));
        return;
      }
      case "heartbeat": {
        const found = await this.repository.touchHeartbeat(runtimeId);
        if (!found) {
          ws.close(RUNTIME_TUNNEL_CLOSE_GONE, "runtime deleted");
        }
        return;
      }
      default:
        this.logger.warn(
          `runtime ${runtimeId} sent unknown tunnel message type`
        );
    }
  }

  private onRpcResponse(runtimeId: string, response: RpcResponse): void {
    if (response.id === null) {
      this.logger.warn(
        `runtime ${runtimeId} sent an RPC response with id=null`
      );
      return;
    }
    const entry = this.pending.get(response.id);
    if (!entry) {
      this.logger.warn(
        `runtime ${runtimeId} sent an RPC response for unknown request ${String(response.id)}`
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
