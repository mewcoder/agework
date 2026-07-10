import { WebSocket, type RawData } from "ws";
import {
  RUNTIME_TUNNEL_CLOSE_GONE,
  type RuntimeTunnelRegisterMessage,
  type RuntimeTunnelServerMessage,
  type RuntimeTunnelRpcRequest,
} from "@agework/shared/protocol";
import {
  isRpcRequest,
  rpcError,
  rpcSuccess,
} from "@agework/shared/protocol/rpc";
import { AGEWORK_VERSION } from "@agework/shared";
import type { RuntimeEnvConfig } from "@agework/shared/api";
import {
  resolveRegisteredRuntimeConfig,
  type RegisteredRuntimeConfig,
  type RuntimeType,
} from "../config.js";
import { detectEnvConfig } from "@agework/shared/cli";
import { createDirectory, listDirectory } from "../filesystem/directory-browser.js";
import {
  listFiles as listFilesDirect,
  readFile as readFileDirect,
  createFsTimeoutSignal,
} from "@agework/shared/filesystem";
import {
  listChangedFiles as listChangedFilesDirect,
  readFileDiff as readFileDiffDirect,
} from "@agework/shared/git";
import type {
  WorkspaceFileListResponse,
  WorkspaceFileReadResponse,
  WorkspaceChangedFilesResponse,
  WorkspaceFileDiffResponse,
} from "@agework/shared/api";
import { Launcher } from "./launcher.js";
import { LiveCarrierStore } from "./registry.js";

/** launcher.ts 暴露的最小契约——tunnel 只依赖这三个方法,不认识 Launcher 内部
 *  怎么装配 providers,方便测试时喂一个假 dispatcher。 */
export interface LaunchDispatcher {
  launch(
    params: RuntimeTunnelRpcRequest["params"]
  ): Promise<{ runtimeInstanceId: string }>;
  stop(params: RuntimeTunnelRpcRequest["params"]): Promise<void>;
  destroy(params: RuntimeTunnelRpcRequest["params"]): Promise<void>;
}

/** 每种运行方式支持的隔离档(注册时上报的能力矩阵)。native 无容器,只有 host 档。 */
const ISOLATION_SCOPES: Record<RuntimeType, string[]> = {
  native: ["host"],
  docker: ["user", "workspace"],
  opensandbox: ["user", "workspace"],
};

function log(message: string, level: "info" | "error" = "info"): void {
  const line = `[agework-runtime] ${new Date().toISOString()} ${message}`;
  if (level === "error") console.error(line);
  else console.log(line);
}

export interface TunnelClientOptions {
  config: RegisteredRuntimeConfig;
  /** 收到的 launch/stop/destroy RPC 转给它执行;它已知自己固定的 runtimeType。 */
  dispatcher: LaunchDispatcher;
  /** runtime 已被 server 删除(收到 4410):调用方应退出进程,不再重连。 */
  onGone: () => void;
  /** 重连退避起始值,仅测试用;默认 1s,翻倍封顶 30s。 */
  reconnectBaseDelayMs?: number;
}

/**
 * 控制隧道客户端:出站 WS 连 server,注册/上报能力/心跳/断线重连,一条连接一个状态机;
 * 同一条连接上还接收 server 下发的 launch/stop/destroy JSON-RPC 请求,转给
 * dispatcher(= Launcher)执行,回一个 RpcResponse。
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
    this.ws?.close(1000, "registered runtime shutting down");
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
      const envConfig = detectEnvConfig();
      const register: RuntimeTunnelRegisterMessage = {
        type: "register",
        runtimeType: this.options.config.runtimeType,
        capabilities: {
          isolationScopes: ISOLATION_SCOPES[this.options.config.runtimeType],
        },
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
      return;
    }

    if (isRpcRequest(parsed)) {
      this.onRpcRequest(ws, parsed as RuntimeTunnelRpcRequest);
      return;
    }

    const message = parsed as RuntimeTunnelServerMessage;
    if (message.type === "registered") {
      log(
        `registered as runtime ${message.runtimeId} (${this.options.config.runtimeType})`
      );
      this.reconnectDelayMs = this.baseDelayMs; // 注册成功即重置退避
      this.scheduleHeartbeat(ws, message.heartbeatIntervalSeconds);
    }
  }

  private onRpcRequest(ws: WebSocket, request: RuntimeTunnelRpcRequest): void {
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
    request: RuntimeTunnelRpcRequest
  ): Promise<
    | { runtimeInstanceId: string }
    | { envConfig: RuntimeEnvConfig }
    | { path: string; entries: string[] }
    | { path: string }
    | WorkspaceFileListResponse
    | WorkspaceFileReadResponse
    | WorkspaceChangedFilesResponse
    | WorkspaceFileDiffResponse
    | void
  > {
    const dispatcher = this.options.dispatcher;
    switch (request.method) {
      case "runtime.launch":
        return dispatcher.launch(request.params);
      case "runtime.stop":
        return dispatcher.stop(request.params);
      case "runtime.destroy":
        return dispatcher.destroy(request.params);
      case "runtime.detect-env":
        return Promise.resolve({ envConfig: detectEnvConfig() });
      case "runtime.list-dir":
        return Promise.resolve(listDirectory(request.params.path));
      case "runtime.create-dir":
        return Promise.resolve(createDirectory(request.params.path));
      case "runtime.list-files":
        return handleListFiles(request.params.rootPath, request.params.path);
      case "runtime.read-file":
        return handleReadFile(request.params.rootPath, request.params.path);
      case "runtime.list-changed-files":
        return listChangedFilesDirect(request.params.rootPath);
      case "runtime.read-file-diff":
        return readFileDiffDirect(request.params.rootPath, request.params.path);
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
    const ceiling = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 30_000);
    // 加抖动:server 重启后大量 manager 不要锁步同时重连(惊群),
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

// ── 文件预览 / git diff 隧道 RPC 处理(复用 shared 安全纯函数) ────────
//
// runtime 进程在那台机器上直读 fs / 跑 git,安全校验(路径越界、symlink 逃逸、
// 二进制探测、大小截断)复用与 worker 相同的 shared 实现(见 ADR-0005 精确化)。
// 返回类型是 API 响应形状(无 commandId),server 侧直接透传。

async function handleListFiles(
  rootPath: string,
  relativePath: string
): Promise<WorkspaceFileListResponse> {
  const signal = createFsTimeoutSignal();
  const result = await listFilesDirect(rootPath, relativePath, signal);
  return {
    path: result.path,
    list: result.list,
    truncated: result.truncated,
  };
}

async function handleReadFile(
  rootPath: string,
  relativePath: string
): Promise<WorkspaceFileReadResponse> {
  const signal = createFsTimeoutSignal();
  const result = await readFileDirect(rootPath, relativePath, signal);
  return {
    path: result.path,
    encoding: result.encoding,
    content: result.content,
    size: result.size,
    truncated: result.truncated,
  };
}

/** Registered Runtime 常驻入口:解析配置、装配 launcher、起隧道、挂信号处理。 */
export async function runRegisteredRuntime(): Promise<void> {
  const config = resolveRegisteredRuntimeConfig(process.argv.slice(2), process.env);
  const dispatcher = new Launcher(config, new LiveCarrierStore());
  const client = new TunnelClient({
    config,
    dispatcher,
    onGone: () => process.exit(0),
  });
  const shutdown = () => {
    client.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  log(
    `registered runtime starting: server=${config.serverBaseUrl} runtime=${config.runtimeType}`
  );
  client.start();
  // 常驻:存活由 WS 连接/重连 timer 维持
  await new Promise(() => {});
}
