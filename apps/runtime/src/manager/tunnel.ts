import { WebSocket, type RawData } from "ws";
import {
  RUNTIME_TUNNEL_CLOSE_GONE,
  type RuntimeTunnelRegisterMessage,
  type RuntimeTunnelServerMessage,
} from "@agework/shared/protocol";
import {
  resolveManagerConfig,
  type ManagerConfig,
  type RuntimeType,
} from "../config.js";

/** 每种运行方式支持的隔离档(注册时上报的能力矩阵)。local 无容器,只有 host 档。 */
const ISOLATION_SCOPES: Record<RuntimeType, string[]> = {
  local: ["host"],
  docker: ["user", "workspace"],
  opensandbox: ["user", "workspace"],
};

function log(message: string, level: "info" | "error" = "info"): void {
  const line = `[agework-runtime] ${new Date().toISOString()} ${message}`;
  if (level === "error") console.error(line);
  else console.log(line);
}

export interface TunnelClientOptions {
  config: ManagerConfig;
  /** runtime 已被 server 删除(收到 4410):调用方应退出进程,不再重连。 */
  onGone: () => void;
  /** 重连退避起始值,仅测试用;默认 1s,翻倍封顶 30s。 */
  reconnectBaseDelayMs?: number;
}

/**
 * 控制隧道客户端:出站 WS 连 server,注册/上报能力/心跳/断线重连,一条连接一个状态机。
 * Phase 2 在同一连接上叠加 launch/stop RPC 的接收。
 */
export class TunnelClient {
  private ws?: WebSocket;
  private heartbeatTimer?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private readonly baseDelayMs: number;
  private reconnectDelayMs: number;
  private stopped = false;

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
    this.ws?.close(1000, "manager shutting down");
  }

  private tunnelUrl(): string {
    const base = this.options.config.serverBaseUrl;
    return `${base.replace(/^http/, "ws")}/runtimes/tunnel`;
  }

  private connect(): void {
    if (this.stopped) return;
    const ws = new WebSocket(this.tunnelUrl(), {
      headers: { authorization: `Bearer ${this.options.config.token}` },
    });
    this.ws = ws;
    ws.on("open", () => {
      const register: RuntimeTunnelRegisterMessage = {
        type: "register",
        runtimeType: this.options.config.runtimeType,
        capabilities: {
          isolationScopes: ISOLATION_SCOPES[this.options.config.runtimeType],
        },
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
    let message: RuntimeTunnelServerMessage;
    try {
      message = JSON.parse(
        Buffer.isBuffer(data) ? data.toString("utf8") : String(data)
      ) as RuntimeTunnelServerMessage;
    } catch {
      log("malformed tunnel message from server", "error");
      return;
    }
    if (message.type === "registered") {
      log(
        `registered as runtime ${message.runtimeId} (${this.options.config.runtimeType})`
      );
      this.reconnectDelayMs = this.baseDelayMs; // 注册成功即重置退避
      this.scheduleHeartbeat(ws, message.heartbeatIntervalSeconds);
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
    if (this.stopped) return;
    if (code === RUNTIME_TUNNEL_CLOSE_GONE) {
      log("runtime deleted on server (4410), exiting", "error");
      this.stopped = true;
      this.options.onGone();
      return;
    }
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 30_000);
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

/** manager 常驻入口:解析配置、起隧道、挂信号处理。 */
export async function runManager(): Promise<void> {
  const config = resolveManagerConfig(process.argv.slice(2), process.env);
  const client = new TunnelClient({
    config,
    onGone: () => process.exit(0),
  });
  const shutdown = () => {
    client.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  log(
    `manager starting: server=${config.serverBaseUrl} runtime=${config.runtimeType}`
  );
  client.start();
  // 常驻:存活由 WS 连接/重连 timer 维持
  await new Promise(() => {});
}
