import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { WebSocket, type RawData } from "ws";
import {
  RUNTIME_TUNNEL_CLOSE_GONE,
  type HostTunnelRegisterMessage,
  type HostTunnelServerMessage,
  type HostTunnelAllRpcRequest,
  type HostTunnelHostNotification,
  type RuntimeHostContract,
  type HostListWorkersRpcResult,
  type InstallCliResult,
  type RuntimeCapabilities,
  type WorkerScope,
} from "@agework/shared/protocol";
import {
  isRpcNotification,
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
import { detectEnvConfig, resolveInstalledBinPath } from "@agework/shared/cli";
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
import { TunnelUpstream } from "../host/tunnel-upstream.js";
import { RuntimeHost, type RuntimeHostConfig } from "../host/runtime-host.js";
import { WorkerHttpServer } from "../host/worker-http-server.js";

/** 每种运行方式支持的 worker scope（注册时上报的能力矩阵）。 */
const RUNTIME_TYPE_SCOPES: Record<RuntimeType, WorkerScope[]> = {
  native: ["workspace"],
  docker: ["user", "workspace"],
  opensandbox: ["user", "workspace"],
};

/** 按 runtimeTypes 构建能力矩阵条目(scope 表 + 各类型的可用性)。 */
function buildCapabilities(
  runtimeTypes: RuntimeType[],
  availabilityOf: (runtimeType: RuntimeType) => {
    available: boolean;
    reason?: string;
  }
): RuntimeCapabilities {
  return Object.fromEntries(
    runtimeTypes.map((runtimeType) => [
      runtimeType,
      {
        ...availabilityOf(runtimeType),
        scopes: RUNTIME_TYPE_SCOPES[runtimeType],
      },
    ])
  );
}

/**
 * 启动时探测一种 runtimeType 在本机的真实可用性:
 * - native:Host 进程能跑就可用;
 * - docker:`docker info` 探测 daemon 是否可达;
 * - opensandbox:registered daemon 尚无 sandbox 接入配置,恒不可用。
 */
function detectRuntimeTypeAvailability(runtimeType: RuntimeType): {
  available: boolean;
  reason?: string;
} {
  if (runtimeType === "native") return { available: true };
  if (runtimeType === "docker") {
    const result = spawnSync("docker", ["info"], {
      stdio: "ignore",
      timeout: 10_000,
    });
    return result.status === 0
      ? { available: true }
      : { available: false, reason: "docker daemon not reachable" };
  }
  return {
    available: false,
    reason: "opensandbox is not configured on this host",
  };
}

function log(message: string, level: "info" | "error" = "info"): void {
  const line = `[agework-runtime] ${new Date().toISOString()} ${message}`;
  if (level === "error") console.error(line);
  else console.log(line);
}

export interface TunnelClientOptions {
  config: RegisteredRuntimeConfig;
  /** register 上报的能力矩阵(每种 runtimeType 的可用性 + scope);
   *  未提供时按 config.runtimeTypes 全部可用构建(测试便利)。 */
  capabilities?: RuntimeCapabilities;
  /** Host 控制面契约；所有 RPC 都委托给它。 */
  hostContract: RuntimeHostContract;
  /** Phase 2: Host 上行通知的隧道实现,连接建立/断开时由 TunnelClient 接线。 */
  tunnelUpstream?: TunnelUpstream;
  /** runtime 已被 server 删除(收到 4410):调用方应退出进程,不再重连。 */
  onGone: () => void;
  /** 重连退避起始值,仅测试用;默认 1s,翻倍封顶 30s。 */
  reconnectBaseDelayMs?: number;
}

/**
 * 控制隧道客户端:出站 WS 连 server,注册/上报能力/心跳/断线重连,一条连接一个状态机;
 * 同一条连接上还接收 server 下发的 host.* JSON-RPC 请求并回一个 RpcResponse。
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
        capabilities:
          this.options.capabilities ??
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
      return;
    }

    if (isRpcRequest(parsed)) {
      this.onRpcRequest(ws, parsed as HostTunnelAllRpcRequest);
      return;
    }

    // Phase 2: server 的单向通知——ACK 水位清缓冲 / run 终结清状态
    if (isRpcNotification(parsed)) {
      const notification = parsed as HostTunnelHostNotification;
      if (notification.method === "host.upstreamAck") {
        const { seq } = notification.params;
        this.options.tunnelUpstream?.onAck(seq);
      } else if (notification.method === "host.releaseRun") {
        this.options.hostContract.releaseRun(notification.params);
      }
      return;
    }

    const message = parsed as HostTunnelServerMessage;
    if (message.type === "registered") {
      log(
        `registered as runtime ${message.runtimeHostId} (${this.options.config.runtimeTypes.join(",")})`
      );
      this.reconnectDelayMs = this.baseDelayMs; // 注册成功即重置退避
      // Phase 2: 注册完成才接线上行通道(绑定会话 epoch),并补发未 ACK 通知
      this.options.tunnelUpstream?.setSession(ws, message.epoch);
      this.scheduleHeartbeat(ws, message.heartbeatIntervalSeconds);
    }
  }

  private onRpcRequest(
    ws: WebSocket,
    request: HostTunnelAllRpcRequest
  ): void {
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

/** Registered Runtime 常驻入口:解析配置、装配 RuntimeHost + worker HTTP + 隧道。 */
export async function runRegisteredRuntime(): Promise<void> {
  const config = resolveRegisteredRuntimeConfig(
    process.argv.slice(2),
    process.env
  );
  const workerPort = config.workerPort ?? 7101;
  const workerApiBaseUrl = `http://127.0.0.1:${workerPort}/api/v1`;
  const userWorkspaceRoot =
    config.userWorkspaceRoot ?? "/home/agework/workspaces";
  // 与 server 侧 builtin Host 的约定一致:~/.agework/cli/<agent>/
  const cliInstallDir = join(homedir(), ".agework", "cli");
  // 启动时按类型探测一次真实可用性,register 上报 + Host 能力矩阵共用
  const capabilities = buildCapabilities(
    config.runtimeTypes,
    detectRuntimeTypeAvailability
  );

  // Phase 2: RuntimeHost 管理 worker 池、命令信箱、握手、fence。
  // providerConfig.serverBaseUrl 设为 Host 的 worker HTTP 端点——
  // provider（native/sandbox）用它设置 worker 的 AGEWORK_WORKER_API_BASE，
  // 使 worker 数据面对端从 server 切到 Host。
  const hostConfig: RuntimeHostConfig = {
    runtimeLogDir: config.runtimeLogHostPath,
    getUserWorkspace: (username) => {
      const dir = join(userWorkspaceRoot, username);
      mkdirSync(dir, { recursive: true });
      return dir;
    },
    launchTimeoutMs: 60_000,
    heartbeatTimeoutMs: 120_000,
    agentEventTrace: { enabled: false, maxFileMb: 50 },
    cliInstallDir,
    capabilities,
    providerConfig: {
      workerImage: config.workerImage ?? "",
      runtimeLogHostPath: config.runtimeLogHostPath,
      serverBaseUrl: workerApiBaseUrl,
      native: {
        runtimeEntryPath: config.runtimeEntryPath ?? process.argv[1] ?? "",
      },
      openSandbox: {
        domain: "",
        protocol: "https",
        apiKey: undefined,
        useServerProxy: false,
      },
    },
    workerApiBaseUrl,
    // native runtimeType 的 CLI 路径:Host 就是执行机器本机——
    // 一键安装目录优先(host.installCli 装的),否则按本机 PATH 检测结果
    resolveCliPaths: async () => {
      const envConfig = detectEnvConfig();
      return {
        claude:
          resolveInstalledBinPath(cliInstallDir, "claude") ??
          envConfig.claude.executablePath,
        codex:
          resolveInstalledBinPath(cliInstallDir, "codex") ??
          envConfig.codex.executablePath,
        opencode:
          resolveInstalledBinPath(cliInstallDir, "opencode") ??
          envConfig.opencode.executablePath,
      };
    },
  };
  const runtimeHost = new RuntimeHost(hostConfig);

  // 上行通知经隧道回流 server
  const tunnelUpstream = new TunnelUpstream();
  runtimeHost.setUpstream(tunnelUpstream);

  // worker HTTP 服务器——worker 的数据面对端
  const httpServer = new WorkerHttpServer(runtimeHost, workerPort);
  await httpServer.start();

  const client = new TunnelClient({
    config,
    capabilities,
    hostContract: runtimeHost,
    tunnelUpstream,
    onGone: () => process.exit(0),
  });
  const shutdown = () => {
    client.stop();
    // 停掉名下所有 worker 运行实例(目标架构不做跨重启容器复用),超时兜底强退
    const stopAll = runtimeHost
      .listWorkers()
      .then((workers) =>
        Promise.allSettled(
          workers.map((w) =>
            runtimeHost.stopWorker({
              runtimeHostId: w.runtimeHostId,
              key: w.workerKey,
            })
          )
        )
      );
    const timeout = new Promise((resolve) => setTimeout(resolve, 10_000));
    void Promise.race([stopAll, timeout]).then(() => {
      runtimeHost.drain();
      void httpServer.stop();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  log(
    `registered runtime starting: server=${config.serverBaseUrl} runtimes=${config.runtimeTypes.join(",")} workerPort=${workerPort}`
  );
  client.start();
  // 常驻:存活由 WS 连接/重连 timer 维持
  await new Promise(() => {});
}
