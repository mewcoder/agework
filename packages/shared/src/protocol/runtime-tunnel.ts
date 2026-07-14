import type { RpcRequest, RpcResponse, RpcNotification } from "./rpc";
import type { RuntimeSpec, CommandPayload } from "./channel";
import type { RunChannelMessage } from "./run-channel-message";
import type {
  SubmitRunInput,
  OwnerKey,
  ExecutionRef,
  WorkerKey,
  WorkerSnapshot,
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

// ── launch / stop / destroy(server → manager,JSON-RPC 2.0,复用 ./rpc 的信封)──
//
// 同一条隧道连接上叠加的第二类消息:register/heartbeat(上面)是简单通知,
// launch/stop/destroy 是有去有回的请求/响应,借用 worker 命令通道已经在用的
// RpcRequest/RpcResponse 信封(见 ./rpc),不新造一套包装。

/** server → manager 的一次 launch 请求参数。是 packages/providers 的
 *  RuntimeLaunchContext 去掉 runtimeType(manager 实例专一,已知自己固定的类型,
 *  不需要传)后的可序列化子集——两者字段含义必须保持同步。 */
export type RuntimeLaunchRpcParams = {
  ownerId: string;
  workspaceId: string;
  runId: string;
  placement: RuntimeSpec;
  workerEnv: Record<string, string>;
  expectedRuntimeInstanceId: string | null;
};

/** server → manager 的 stop/destroy 共用参数,对应 packages/providers 的
 *  RuntimeInstanceRef 去掉 runtimeType(同上,manager 已知自己的类型)。 */
export type RuntimeInstanceRefRpcParams = {
  ownerId: string;
  workerId: string;
  runtimeInstanceId: string;
  isolationScope: string;
};

/** server → manager：触发重新检测本机 agent CLI 环境并上报结果。 */
export type RuntimeDetectEnvRpcParams = Record<string, never>;

/** server → manager：列出 path 下的子目录（不含文件）。path 省略时列出 manager 本机的用户主目录。 */
export type RuntimeListDirRpcParams = { path?: string };

/** server → manager：在 path 下新建一个目录（含父级）。 */
export type RuntimeCreateDirRpcParams = { path: string };

/** server → manager：列出 rootPath 下 relativePath 的文件列表（含文件，非纯目录）。 */
export type RuntimeListFilesRpcParams = { rootPath: string; path: string };

/** server → manager：读取 rootPath 下 relativePath 的文件内容（文本或图片 base64）。 */
export type RuntimeReadFileRpcParams = { rootPath: string; path: string };

/** server → manager：列出 rootPath 下相对 HEAD 的累计变更文件（git-only、只读）。 */
export type RuntimeListChangedFilesRpcParams = { rootPath: string };

/** server → manager：读取 rootPath 下 relativePath 的 before/after diff（git）。 */
export type RuntimeReadFileDiffRpcParams = { rootPath: string; path: string };

/** server → manager：列出 rootPath 下所有文件相对路径（git ls-files，供 `@` 文件提及）。 */
export type RuntimeSearchFilesRpcParams = { rootPath: string };

export type RuntimeTunnelRpcRequest =
  | RpcRequest<"runtime.launch", RuntimeLaunchRpcParams>
  | RpcRequest<"runtime.stop", RuntimeInstanceRefRpcParams>
  | RpcRequest<"runtime.destroy", RuntimeInstanceRefRpcParams>
  | RpcRequest<"runtime.detect-env", RuntimeDetectEnvRpcParams>
  | RpcRequest<"runtime.list-dir", RuntimeListDirRpcParams>
  | RpcRequest<"runtime.create-dir", RuntimeCreateDirRpcParams>
  | RpcRequest<"runtime.list-files", RuntimeListFilesRpcParams>
  | RpcRequest<"runtime.read-file", RuntimeReadFileRpcParams>
  | RpcRequest<"runtime.list-changed-files", RuntimeListChangedFilesRpcParams>
  | RpcRequest<"runtime.read-file-diff", RuntimeReadFileDiffRpcParams>
  | RpcRequest<"runtime.search-files", RuntimeSearchFilesRpcParams>;

export type RuntimeLaunchRpcResult = { runtimeInstanceId: string };
export type RuntimeDetectEnvRpcResult = { envConfig: RuntimeEnvConfig };
/** entries 为完整绝对路径(不是裸名字):拼接、排序均由 manager 端做好,server 直接展示。 */
export type RuntimeListDirRpcResult = { path: string; entries: string[] };
export type RuntimeCreateDirRpcResult = { path: string };
export type RuntimeListFilesRpcResult = WorkspaceFileListResponse;
export type RuntimeReadFileRpcResult = WorkspaceFileReadResponse;
export type RuntimeListChangedFilesRpcResult = WorkspaceChangedFilesResponse;
export type RuntimeReadFileDiffRpcResult = WorkspaceFileDiffResponse;
export type RuntimeSearchFilesRpcResult = WorkspaceFileSearchResponse;

export type RuntimeTunnelRpcResponse =
  | RpcResponse<RuntimeLaunchRpcResult>
  | RpcResponse<RuntimeDetectEnvRpcResult>
  | RpcResponse<RuntimeListDirRpcResult>
  | RpcResponse<RuntimeCreateDirRpcResult>
  | RpcResponse<RuntimeListFilesRpcResult>
  | RpcResponse<RuntimeReadFileRpcResult>
  | RpcResponse<RuntimeListChangedFilesRpcResult>
  | RpcResponse<RuntimeReadFileDiffRpcResult>
  | RpcResponse<RuntimeSearchFilesRpcResult>
  | RpcResponse<null>;

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
  | RpcRequest<"host.listWorkers", Record<string, never>>
  | RpcRequest<"host.stopWorker", { key: WorkerKey }>;

/** host.listWorkers 响应：本 Host 的 worker 快照列表。 */
export type HostListWorkersRpcResult = { workers: WorkerSnapshot[] };

export type RuntimeTunnelHostRpcResponse =
  | RpcResponse<HostListWorkersRpcResult>
  | RpcResponse<null>;

export type RuntimeTunnelHostNotification =
  | RpcNotification<"host.upstream", HostUpstreamEnvelope>
  | RpcNotification<"host.upstreamAck", HostUpstreamAckParams>
  | RpcNotification<"host.releaseRun", HostReleaseRunParams>;

/** Phase 2 扩展后的全量 RPC 请求类型。 */
export type RuntimeTunnelAllRpcRequest =
  | RuntimeTunnelRpcRequest
  | RuntimeTunnelHostRpcRequest;

/** Phase 2 扩展后的全量 RPC 响应类型。 */
export type RuntimeTunnelAllRpcResponse =
  | RuntimeTunnelRpcResponse
  | RuntimeTunnelHostRpcResponse;

// 注意:本文件只放类型。隧道关闭码 RUNTIME_TUNNEL_CLOSE_GONE 是运行时值,
// 内联在 protocol/index.ts(shared 源码直连消费,跨文件 re-export 值会 ERR_MODULE_NOT_FOUND)。
