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
  RUNTIME_HOST_TUNNEL_PROTOCOL_VERSION,
  RUNTIME_TUNNEL_CLOSE_INCOMPATIBLE,
  RUNTIME_TUNNEL_CLOSE_GONE,
  normalizeRuntimeCapabilities,
  type HostTunnelRegisteredMessage,
  type HostTunnelAllRpcRequest,
  type HostTunnelHostNotification,
  type HostUpstreamEnvelope,
} from "@agework/shared/protocol";
import { type RpcId, type RpcResponse } from "@agework/shared/protocol/rpc";
import {
  isHostTunnelClientNotification,
  isHostTunnelClientMessage,
  isHostTunnelHostRpcResponse,
  isWireMessageType,
} from "@agework/shared/protocol/wire";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { ConfigService } from "../../config/config.service";
import { RuntimeHostRepository } from "../runtime-host.repository";
import {
  RUNTIME_HOST_CONNECTED_EVENT,
  RuntimeHostConnectedEvent,
} from "../runtime-host.events";
import type { HostUpstreamPort, HostRunReapPort } from "../runtime-host.types";
import { AGEWORK_VERSION } from "@agework/shared";

/** 隧道 WS 关闭码:同名 Runtime Host 的新连接顶掉旧连接。 */
const CLOSE_REPLACED = 4409;

type PendingRequest = {
  runtimeHostId: string;
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
};

/**
 * registered Runtime Host 控制隧道的 server 端:接受 agework-runtime daemon 的出站 WS,
 * 配对 token(sha256 比对)鉴权;register 握手校验通过后才把连接绑定为该 Host 的
 * 路由身份(在线、可收 RPC),断连即标 offline;同一条连接上还承载 host.* JSON-RPC
 * 请求/响应。server 永不反连 Host——这里只被动收连接、主动发的只有已建连上的 RPC 请求。
 */
@Injectable()
export class HostTunnelHandler
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(HostTunnelHandler.name);
  private readonly tunnelPath: string;
  private readonly connections = new Map<string, WebSocket>();
  private readonly pending = new Map<RpcId, PendingRequest>();
  /** host.upstream 回流 Port(契约见 runtime-host.types.ts),由 RuntimeHostAdapter 实现接线。
   *  处理返回 Promise 时按连接串行 await(保事件顺序),处理完成后回 ACK。 */
  private hostUpstreamPort?: HostUpstreamPort;
  /** Host 终态收尾 Port,由 RuntimeHostAdapter 接线、run 上层实现;进程更替 /
   *  优雅关停时同步调用。 */
  private runReapPort?: HostRunReapPort;
  /** Phase 2: 每个 Runtime Host 的隧道会话状态。epoch 每次 register 递增,
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
    private readonly repository: RuntimeHostRepository,
    private readonly configService: ConfigService,
    private readonly httpAdapterHost: HttpAdapterHost,
    private readonly events: EventEmitter2
  ) {
    this.tunnelPath = `${configService.getApiBasePath()}/runtime-hosts/tunnel`;
  }

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

  /** 删除 Runtime Host 后踢掉在线连接(daemon 收 4410 应退出,不再重连)。 */
  closeConnection(runtimeHostId: string): void {
    const socket = this.connections.get(runtimeHostId);
    if (!socket) return;
    this.connections.delete(runtimeHostId);
    socket.close(RUNTIME_TUNNEL_CLOSE_GONE, "runtime host deleted");
  }

  /**
   * 判死回收:强制丢弃心跳超时的半开僵尸连接,让 isConnected() 与 DB 收敛,
   * 不再把 RPC 发到死 socket 上干等超时。用 terminate 而非 close——半开连接
   * 的关闭握手可能永远等不到对端回应;terminate 触发 'close' 事件,复用既有
   * 清理(reject pending + markOffline)。区别于 closeConnection 的 4410 删除
   * 语义:这里不预删 connections,client 收到异常关闭(1006)后正常重连。
   */
  reapConnection(runtimeHostId: string): void {
    this.connections.get(runtimeHostId)?.terminate();
  }

  /** Runtime Host 是否在线（隧道连接存在）。 */
  isConnected(runtimeHostId: string): boolean {
    return this.connections.has(runtimeHostId);
  }

  /** Phase 2: 列出所有在线（隧道连接存在）的 Runtime Host id。 */
  listConnected(): string[] {
    return [...this.connections.keys()];
  }

  /** 接线 host.upstream 回流 Port(启动期一次)。 */
  setHostUpstreamPort(port: HostUpstreamPort): void {
    this.hostUpstreamPort = port;
  }

  /** 接线 Host 终态收尾 Port(启动期一次)。 */
  setHostRunReapPort(port: HostRunReapPort): void {
    this.runReapPort = port;
  }

  /** 向目标 runtimeHostId 发一条单向通知(不等回应,不在线即丢弃,best-effort)。 */
  sendNotification(
    runtimeHostId: string,
    notification: HostTunnelHostNotification
  ): void {
    const socket = this.connections.get(runtimeHostId);
    // 关停/断连窗口内 socket 尚未从 connections 摘除,但 send 会打到 CLOSING/CLOSED
    // 连接上抛错——best-effort 通知只在 OPEN 时发(尤其 shutdown 收尾恰在此窗口)。
    if (!socket || socket.readyState !== socket.OPEN) return;
    socket.send(JSON.stringify(notification));
  }

  /** 向目标 runtimeHostId 发一次 RPC（launch/stop/destroy/host.*），等它回应或超时。
   *  Phase 2 扩展：接受 HostTunnelAllRpcRequest，包含 host.submitRun/command/releaseOwner。 */
  sendRequest<Result>(
    runtimeHostId: string,
    request: HostTunnelAllRpcRequest,
    timeoutMs: number
  ): Promise<Result> {
    const socket = this.connections.get(runtimeHostId);
    // 关停/断连窗口内 socket 尚未从 connections 摘除;在此 send 会抛错并遗留
    // timer + pending 条目,故提前判 OPEN,与未连接同样 reject。
    if (!socket || socket.readyState !== socket.OPEN) {
      return Promise.reject(
        new Error(`runtime host ${runtimeHostId} is not connected`)
      );
    }
    return new Promise<Result>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.id);
        reject(
          new Error(
            `runtime host ${runtimeHostId} did not respond to ${request.method} within ${timeoutMs}ms`
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
    const runtimeHost = await this.repository.findByTokenHash(tokenHash);
    return runtimeHost?.id ?? null;
  }

  private attach(runtimeHostId: string, ws: WebSocket): void {
    // token 鉴权只决定连接可以说话;路由身份(connections 绑定)在 register
    // 握手校验通过后才建立——未注册的连接不可被 RPC/广播触达,也不会顶掉在线连接。
    // 一个心跳判死窗口内没完成注册的连接直接踢掉,不让它无限挂着。
    const registerTimer = setTimeout(() => {
      if (this.connections.get(runtimeHostId) !== ws) {
        ws.close(1008, "register timeout");
      }
    }, this.configService.getHeartbeatTimeoutSeconds() * 1000);
    registerTimer.unref?.();
    ws.on("message", (data: RawData) => {
      void this.onMessage(runtimeHostId, ws, data).catch((err: unknown) => {
        this.logger.warn(
          `tunnel message from runtime host ${runtimeHostId} failed: ${err instanceof Error ? err.message : String(err)}`
        );
      });
    });
    ws.on("close", () => {
      clearTimeout(registerTimer);
      if (this.connections.get(runtimeHostId) !== ws) return; // 已被新连接顶掉
      this.connections.delete(runtimeHostId);
      this.rejectPendingFor(runtimeHostId, "connection closed");
      // builtin Host 在 server 进程内，不会建立隧道；所有隧道连接都属于
      // registered Host，断连即标记离线。
      void this.repository.markOffline(runtimeHostId).catch((err: unknown) => {
        this.logger.warn(
          `mark runtime host ${runtimeHostId} offline failed: ${err instanceof Error ? err.message : String(err)}`
        );
      });
    });
  }

  /** 连接断开时,这台 Runtime Host 上还没等到回应的 RPC 永远等不到了,主动拒绝掉。 */
  private rejectPendingFor(runtimeHostId: string, reason: string): void {
    for (const [id, entry] of this.pending) {
      if (entry.runtimeHostId !== runtimeHostId) continue;
      clearTimeout(entry.timer);
      this.pending.delete(id);
      entry.reject(new Error(`runtime host ${runtimeHostId} ${reason}`));
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
      this.logger.warn(
        `runtime host ${runtimeHostId} sent malformed tunnel message`
      );
      ws.close(1008, "malformed tunnel message");
      return;
    }

    if (isHostTunnelHostRpcResponse(parsed)) {
      if (this.connections.get(runtimeHostId) !== ws) {
        this.logger.warn(
          `dropped RPC response from an unregistered connection of runtime host ${runtimeHostId}`
        );
        return;
      }
      this.onRpcResponse(runtimeHostId, parsed);
      return;
    }

    // Phase 2: host.upstream 通知（Host → server，单向,带 seq/epoch 信封）
    if (isHostTunnelClientNotification(parsed)) {
      this.onUpstreamEnvelope(runtimeHostId, ws, parsed.params);
      return;
    }

    if (isWireMessageType(parsed, "register")) {
      if (parsed.protocolVersion !== RUNTIME_HOST_TUNNEL_PROTOCOL_VERSION) {
        this.logger.warn(
          `runtime host ${runtimeHostId} tunnel protocol mismatch: host=${String(parsed.protocolVersion)} server=${RUNTIME_HOST_TUNNEL_PROTOCOL_VERSION}`
        );
        ws.close(
          RUNTIME_TUNNEL_CLOSE_INCOMPATIBLE,
          "incompatible tunnel protocol"
        );
        return;
      }
      if (!isHostTunnelClientMessage(parsed)) {
        this.logger.warn(
          `runtime host ${runtimeHostId} sent an invalid register handshake`
        );
        ws.close(1008, "invalid register handshake");
        return;
      }
      const capabilities = normalizeRuntimeCapabilities(parsed.capabilities);
      const { found, previousProcessInstanceId } =
        await this.repository.markRegistered(
          runtimeHostId,
          capabilities,
          parsed.processInstanceId,
          parsed.envConfig
        );
      if (!found) {
        ws.close(RUNTIME_TUNNEL_CLOSE_GONE, "runtime host deleted");
        return;
      }
      // Host 换了进程实例:旧进程的 run 会话 / 未 ACK 缓冲已随进程消失,在绑定新
      // 连接、回 registered 之前先确定性收尾旧 run——否则新进程标 online 后,
      // run-recovery 见 Host 在线便不判死,旧 run 永远挂在 running(僵尸 run)。
      if (
        previousProcessInstanceId &&
        previousProcessInstanceId !== parsed.processInstanceId
      ) {
        this.logger.warn(
          `runtime host ${runtimeHostId} reincarnated (process instance ${previousProcessInstanceId} → ${parsed.processInstanceId}); reaping stale runs`
        );
        await this.runReapPort?.reapActiveRuns(runtimeHostId, "reincarnation");
      }
      // 握手校验通过,此刻才绑定路由身份:顶掉同名旧连接、登记为在线连接
      const previous = this.connections.get(runtimeHostId);
      if (previous && previous !== ws) {
        previous.close(CLOSE_REPLACED, "replaced");
      }
      this.connections.set(runtimeHostId, ws);
      if (parsed.version && parsed.version !== AGEWORK_VERSION) {
        this.logger.warn(
          `runtime host ${runtimeHostId} version mismatch: daemon=${parsed.version} server=${AGEWORK_VERSION} (允许接入,registered daemon 单独构建后可能与 server 漂移)`
        );
      }
      const reply: HostTunnelRegisteredMessage = {
        type: "registered",
        runtimeHostId,
        heartbeatIntervalSeconds: this.heartbeatIntervalSeconds(),
        protocolVersion: RUNTIME_HOST_TUNNEL_PROTOCOL_VERSION,
        // Phase 2: 每次 register 递增会话 epoch,Host 盖在上行信封里,
        // 被顶掉的旧连接残留消息按 epoch 丢弃(防脑裂)。
        epoch: this.nextEpoch(runtimeHostId),
      };
      ws.send(JSON.stringify(reply));
      // 注册成功的事实:下游据此做重连对账(如补发离线期间丢失的 owner 级释放)
      this.events.emit(
        RUNTIME_HOST_CONNECTED_EVENT,
        new RuntimeHostConnectedEvent(runtimeHostId)
      );
      return;
    }

    if (isHostTunnelClientMessage(parsed) && parsed.type === "heartbeat") {
      if (this.connections.get(runtimeHostId) !== ws) {
        this.logger.warn(
          `dropped heartbeat from an unregistered connection of runtime host ${runtimeHostId}`
        );
        return;
      }
      const found = await this.repository.touchHeartbeat(runtimeHostId);
      if (!found) {
        ws.close(RUNTIME_TUNNEL_CLOSE_GONE, "runtime host deleted");
      }
      return;
    }

    if (isHostTunnelClientMessage(parsed) && parsed.type === "shutdown") {
      // Host 主动关停通告:daemon 正优雅退出,worker 池随进程消失,其上 active run
      // 无从续传。确定性收尾,不必等 Host 离线兜底 sweep 的宽限窗口(几分钟)。
      // 只认当前注册连接,防被顶掉的旧连接误触收尾。
      if (this.connections.get(runtimeHostId) !== ws) {
        this.logger.warn(
          `dropped shutdown notice from an unregistered connection of runtime host ${runtimeHostId}`
        );
        return;
      }
      this.logger.log(
        `runtime host ${runtimeHostId} announced graceful shutdown; reaping its active runs`
      );
      await this.runReapPort?.reapActiveRuns(runtimeHostId, "shutdown");
      return;
    }

    this.logger.warn(
      `runtime host ${runtimeHostId} sent invalid tunnel message`
    );
    ws.close(1008, "invalid tunnel message");
  }

  /** register 时递增该 Runtime Host 的隧道会话 epoch 并返回。 */
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
   * 2. 按 Runtime Host 串行 await 处理(保事件顺序,处理失败记日志不中断——
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
        `dropped upstream from a replaced connection of runtime host ${runtimeHostId}`
      );
      return;
    }
    // Host 只发带 seq/epoch 的信封(Phase 2 双栈兼容的裸 notification 分支已删),
    // 不合形状的消息直接丢弃。
    if (envelope.notification === undefined) {
      this.logger.warn(
        `dropped malformed upstream envelope from runtime host ${runtimeHostId}`
      );
      return;
    }
    if (envelope.epoch !== undefined && envelope.epoch !== session?.epoch) {
      this.logger.warn(
        `dropped stale-epoch upstream from runtime host ${runtimeHostId}: epoch=${envelope.epoch} current=${session?.epoch ?? "none"}`
      );
      return;
    }
    if (!session) return; // 未注册就发上行:异常客户端,丢弃
    session.chain = session.chain
      .then(async () => {
        try {
          await this.hostUpstreamPort?.onHostUpstream(
            runtimeHostId,
            envelope.notification
          );
        } catch (err) {
          this.logger.warn(
            `upstream handler failed for runtime host ${runtimeHostId} seq=${envelope.seq}: ${err instanceof Error ? err.message : String(err)}`
          );
        }
        this.sendUpstreamAck(runtimeHostId, ws, envelope.seq);
      })
      .catch(() => {});
  }

  private sendUpstreamAck(
    runtimeHostId: string,
    ws: WebSocket,
    seq: number
  ): void {
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
        `runtime host ${runtimeHostId} sent an RPC response with id=null`
      );
      return;
    }
    const entry = this.pending.get(response.id);
    if (!entry) {
      this.logger.warn(
        `runtime host ${runtimeHostId} sent an RPC response for unknown request ${String(response.id)}`
      );
      return;
    }
    if (entry.runtimeHostId !== runtimeHostId) {
      // 防御:响应必须来自当初收到请求的那条连接,不能拿别人的 id 解掉本请求
      this.logger.warn(
        `runtime host ${runtimeHostId} sent an RPC response for a request owned by ${entry.runtimeHostId}`
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
