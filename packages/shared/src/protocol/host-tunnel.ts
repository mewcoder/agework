import type { RpcRequest, RpcResponse, RpcNotification } from "./rpc";
import type { RunChannelMessage } from "./run-channel-message";
import type {
  SubmitRunInput,
  ReleaseOwnerInput,
  RuntimeHostCommandInput,
  RuntimeHostRunRef,
  StopWorkerInput,
  InstallCliInput,
  InstallCliResult,
  WorkerSnapshot,
  HostCapabilityStatus,
  ListDirectoryInput,
  DirectoryListing,
  CreateDirectoryInput,
  WorkspaceFileQuery,
  ReadFileInput,
  ReadFileDiffInput,
  SearchFilesInput,
  ListChangedFilesInput,
  WorkspaceFileListResponse,
  WorkspaceFileReadResponse,
  WorkspaceFileSearchResponse,
  WorkspaceChangedFilesResponse,
  WorkspaceFileDiffResponse,
} from "./runtime-host";
import type { RuntimeCapabilities } from "./runtime-capabilities";
import type { RuntimeEnvConfig } from "../common";

/**
 * registered Runtime Host 控制隧道协议(Runtime Host ⇄ Server gateway)。
 * 出站 WS 连接,Runtime Host 配对 token 鉴权(HTTP upgrade 时经 Authorization header 携带);
 * 与 Host↔worker 的数据面(worker-http,startToken 鉴权)完全独立。
 */

export type { RuntimeCapabilities } from "./runtime-capabilities";

/** Host → Server:注册(隧道建连后第一条消息)。 */
export interface HostTunnelRegisterMessage {
  type: "register";
  capabilities: RuntimeCapabilities;
  /** 控制隧道线协议版本。缺失或不匹配都拒绝注册。 */
  protocolVersion: number;
  /** Host 进程实例标识。同一进程断线重连保持不变;进程重启生成新值。
   *  Server 据此区分「同 Host 换了进程」与「同进程重连」——值变化意味着
   *  旧进程的 run session / 未 ACK 缓冲已随进程消失,旧 active run 必须确定性
   *  判死,不能等一个已不存在的会话续传(消灭快速重启的僵尸 run)。 */
  processInstanceId: string;
  /** Host 产物版本(来自 bundled `AGEWORK_VERSION`),Server 用于握手比对告警。 */
  version?: string;
  /** Host 启动时检测本机 agent CLI 的结果（路径/版本/认证状态）。 */
  envConfig?: RuntimeEnvConfig;
}

/** Host → Server:心跳。 */
export interface HostTunnelHeartbeatMessage {
  type: "heartbeat";
}

/** Host → Server:优雅关停通告。daemon 收到关机信号(SIGTERM/SIGINT)、关闭隧道
 *  前发送。Server 据此确定该 Host 是主动永久离开(worker 池随进程消失,run 无从
 *  续传),立即确定性收尾其上 active run,不必等 Host 离线兜底 sweep 的宽限窗口。
 *  best-effort、单向:连接已断则消息发不出,退回 sweep 兜底。 */
export interface HostTunnelShutdownMessage {
  type: "shutdown";
}

export type HostTunnelClientMessage =
  | HostTunnelRegisterMessage
  | HostTunnelHeartbeatMessage
  | HostTunnelShutdownMessage;

/** Server → Host:注册成功回执,带心跳节奏。 */
export interface HostTunnelRegisteredMessage {
  type: "registered";
  runtimeHostId: string;
  heartbeatIntervalSeconds: number;
  /** server 的控制隧道线协议版本。缺失或不匹配都视为不兼容。 */
  protocolVersion: number;
  /** Phase 2: 隧道会话 epoch,每次 register 递增。Host 把它盖在所有
   *  host.upstream 信封上,server 丢弃非当前 epoch 的消息(防脑裂:
   *  被顶掉的旧连接残留消息不得混入新会话)。builtin(进程内)无隧道,不使用。 */
  epoch?: number;
}

export type HostTunnelServerMessage = HostTunnelRegisteredMessage;

// ── 执行面隧道协议 ──────────────────────────────────────────────────
//
// server → Host:submitRun / command / releaseOwner(有去有回,ACK 语义)。
// Host → server:host.upstream(单向通知,承载事件流与终态事实)。
// 所有 Phase 2 消息在 meta 中携带 epoch,server 重启后旧 epoch 消息丢弃。

/** server → Host:提交一次 run。params 就是 RuntimeHostContract.submitRun 的入参。 */
export type HostSubmitRunRpcParams = SubmitRunInput;

/** server → Host:下发 run 级命令。 */
export type HostCommandRpcParams = RuntimeHostCommandInput;

/** server → Host:owner 级释放(定向路由,params 就是 RuntimeHostContract.releaseOwner 的入参)。 */
export type HostReleaseOwnerRpcParams = ReleaseOwnerInput;

/** Host → server:上行事件/终态事实通知(单向)。 */
export type HostUpstreamNotification =
  | { kind: "emit"; runId: string; message: RunChannelMessage }
  | { kind: "runFailed"; runId: string; error: string }
  | { kind: "runCancelled"; runId: string }
  | { kind: "workerLost"; runId: string; reason: string };

/**
 * host.upstream 的传输信封:Host 进程内单调递增 seq + 会话 epoch。
 * Host 缓冲未 ACK 的通知,断线重连(收到新 registered)后按原 seq 补发;
 * server 逐条回 host.upstreamAck(累计水位),Host 收到后丢弃 ≤seq 的缓冲。
 * 跨 server 重启的重复投递由 RunChannelMessage.seq 的 run 级幂等兜底。
 */
export type HostUpstreamEnvelope = {
  /** Host 进程内单调递增(跨重连连续;Host 进程重启后归零重计)。 */
  seq: number;
  /** 当前隧道会话 epoch(来自 registered 回执);server 校验后非当前值丢弃。 */
  epoch?: number;
  notification: HostUpstreamNotification;
};

/** server → Host:host.upstream 的累计 ACK 水位(≤seq 的通知均已被 server 接收)。 */
export type HostUpstreamAckParams = { seq: number };

/** server → Host:run 已终结,Host 清理该 run 的状态(单向,best-effort)。 */
export type HostReleaseRunParams = RuntimeHostRunRef;

export type HostTunnelHostRpcRequest =
  | RpcRequest<"host.submitRun", HostSubmitRunRpcParams>
  | RpcRequest<"host.command", HostCommandRpcParams>
  | RpcRequest<"host.releaseOwner", HostReleaseOwnerRpcParams>
  | RpcRequest<"host.detectEnv", { runtimeHostId: string }>
  | RpcRequest<"host.listDirectory", ListDirectoryInput>
  | RpcRequest<"host.createDirectory", CreateDirectoryInput>
  | RpcRequest<"host.listFiles", WorkspaceFileQuery>
  | RpcRequest<"host.readFile", ReadFileInput>
  | RpcRequest<"host.readFileDiff", ReadFileDiffInput>
  | RpcRequest<"host.searchFiles", SearchFilesInput>
  | RpcRequest<"host.listChangedFiles", ListChangedFilesInput>
  | RpcRequest<"host.listWorkers", Record<string, never>>
  | RpcRequest<"host.stopWorker", StopWorkerInput>
  | RpcRequest<"host.installCli", InstallCliInput>;

/** host.listWorkers 响应：本 Host 的 worker 快照列表。 */
export type HostListWorkersRpcResult = { workers: WorkerSnapshot[] };

export type HostTunnelHostRpcResponse =
  | RpcResponse<HostCapabilityStatus>
  | RpcResponse<DirectoryListing>
  | RpcResponse<WorkspaceFileListResponse>
  | RpcResponse<WorkspaceFileReadResponse>
  | RpcResponse<WorkspaceFileDiffResponse>
  | RpcResponse<WorkspaceFileSearchResponse>
  | RpcResponse<WorkspaceChangedFilesResponse>
  | RpcResponse<HostListWorkersRpcResult>
  | RpcResponse<InstallCliResult>
  | RpcResponse<null>;

export type HostTunnelHostNotification =
  | RpcNotification<"host.upstream", HostUpstreamEnvelope>
  | RpcNotification<"host.upstreamAck", HostUpstreamAckParams>
  | RpcNotification<"host.releaseRun", HostReleaseRunParams>;

/** Runtime Host 控制隧道的全量 RPC 请求类型。 */
export type HostTunnelAllRpcRequest = HostTunnelHostRpcRequest;

/** Runtime Host 控制隧道的全量 RPC 响应类型。 */
export type HostTunnelAllRpcResponse = HostTunnelHostRpcResponse;

// 注意:本文件只放类型。隧道关闭码 RUNTIME_TUNNEL_CLOSE_GONE 是运行时值,
// 内联在 protocol/index.ts(shared 源码直连消费,跨文件 re-export 值会 ERR_MODULE_NOT_FOUND)。
