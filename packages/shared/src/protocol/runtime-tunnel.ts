import type { RpcRequest, RpcResponse, RpcNotification } from "./rpc";
import type { CommandPayload } from "./channel";
import type { RunChannelMessage } from "./run-channel-message";
import type {
  SubmitRunInput,
  OwnerKey,
  ExecutionRef,
  WorkerKey,
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
} from "./runtime-host";
import type { RuntimeCapabilities } from "./runtime-capabilities";
import type { RuntimeEnvConfig } from "../api/runtimes";
import type {
  WorkspaceFileListResponse,
  WorkspaceFileReadResponse,
  WorkspaceFileSearchResponse,
} from "../api/workspace-files";
import type {
  WorkspaceChangedFilesResponse,
  WorkspaceFileDiffResponse,
} from "../api/workspaces";

/**
 * Registered Runtime 控制隧道协议(agework-runtime/manager ⇄ server/runtime-gateway)。
 * 出站 WS 连接,runtime 配对 token 鉴权(HTTP upgrade 时经 Authorization header 携带);
 * 与 worker↔server 的数据面(worker-http,startToken 鉴权)完全独立。
 */

export type { RuntimeCapabilities } from "./runtime-capabilities";

/** manager → server:注册(隧道建连后第一条消息)。 */
export interface RuntimeTunnelRegisterMessage {
  type: "register";
  capabilities: RuntimeCapabilities;
  /** manager 产物版本(来自 bundled `AGEWORK_VERSION`),server 用于握手比对告警。 */
  version?: string;
  /** manager 启动时检测本机 agent CLI 的结果（路径/版本/认证状态）。 */
  envConfig?: RuntimeEnvConfig;
}

/** manager → server:心跳。 */
export interface RuntimeTunnelHeartbeatMessage {
  type: "heartbeat";
}

export type RuntimeTunnelClientMessage =
  | RuntimeTunnelRegisterMessage
  | RuntimeTunnelHeartbeatMessage;

/** server → manager:注册成功回执,带心跳节奏。 */
export interface RuntimeTunnelRegisteredMessage {
  type: "registered";
  runtimeId: string;
  heartbeatIntervalSeconds: number;
  /** Phase 2: 隧道会话 epoch,每次 register 递增。Host 把它盖在所有
   *  host.upstream 信封上,server 丢弃非当前 epoch 的消息(防脑裂:
   *  被顶掉的旧连接残留消息不得混入新会话)。builtin(进程内)无隧道,不使用。 */
  epoch?: number;
}

export type RuntimeTunnelServerMessage = RuntimeTunnelRegisteredMessage;

// ── Phase 2: 执行面隧道协议扩展 ──────────────────────────────────────
//
// server → Host:submitRun / command / releaseOwner(有去有回,ACK 语义)。
// Host → server:host.upstream(单向通知,承载事件流与终态事实)。
// 所有 Phase 2 消息在 meta 中携带 epoch,server 重启后旧 epoch 消息丢弃。

/** server → Host:提交一次 run。params 就是 RuntimeHostContract.submitRun 的入参。 */
export type HostSubmitRunRpcParams = SubmitRunInput;

/** server → Host:下发 run 级命令。 */
export type HostCommandRpcParams = {
  runId: string;
  payload: CommandPayload;
};

/** server → Host:owner 级释放。 */
export type HostReleaseOwnerRpcParams = {
  owner: OwnerKey;
};

/** Host → server:上行事件/终态事实通知(单向)。 */
export type HostUpstreamNotification =
  | { kind: "emit"; runId: string; message: RunChannelMessage }
  | { kind: "runFailed"; runId: string; error: string }
  | { kind: "runCancelled"; runId: string }
  | { kind: "workerLost"; runId: string; reason: string }
  | { kind: "executionRef"; runId: string; ref: ExecutionRef };

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
export type HostReleaseRunParams = { runId: string };

export type RuntimeTunnelHostRpcRequest =
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
  | RpcRequest<"host.stopWorker", { key: WorkerKey }>;

/** host.listWorkers 响应：本 Host 的 worker 快照列表。 */
export type HostListWorkersRpcResult = { workers: WorkerSnapshot[] };

export type RuntimeTunnelHostRpcResponse =
  | RpcResponse<HostCapabilityStatus>
  | RpcResponse<DirectoryListing>
  | RpcResponse<WorkspaceFileListResponse>
  | RpcResponse<WorkspaceFileReadResponse>
  | RpcResponse<WorkspaceFileDiffResponse>
  | RpcResponse<WorkspaceFileSearchResponse>
  | RpcResponse<WorkspaceChangedFilesResponse>
  | RpcResponse<HostListWorkersRpcResult>
  | RpcResponse<null>;

export type RuntimeTunnelHostNotification =
  | RpcNotification<"host.upstream", HostUpstreamEnvelope>
  | RpcNotification<"host.upstreamAck", HostUpstreamAckParams>
  | RpcNotification<"host.releaseRun", HostReleaseRunParams>;

/** Runtime Host 控制隧道的全量 RPC 请求类型。 */
export type RuntimeTunnelAllRpcRequest = RuntimeTunnelHostRpcRequest;

/** Runtime Host 控制隧道的全量 RPC 响应类型。 */
export type RuntimeTunnelAllRpcResponse = RuntimeTunnelHostRpcResponse;

// 注意:本文件只放类型。隧道关闭码 RUNTIME_TUNNEL_CLOSE_GONE 是运行时值,
// 内联在 protocol/index.ts(shared 源码直连消费,跨文件 re-export 值会 ERR_MODULE_NOT_FOUND)。
