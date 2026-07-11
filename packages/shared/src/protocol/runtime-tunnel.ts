import type { RpcRequest, RpcResponse } from "./rpc";
import type { RuntimeSpec } from "./channel";
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

/** Runtime 实例声明的能力矩阵:它那一种运行方式支持哪些隔离档。
 *  (type 而非 interface:需要隐式索引签名以直接写入 Prisma Json 列。) */
export type RuntimeCapabilities = {
  isolationScopes: string[];
};

/** manager → server:注册(隧道建连后第一条消息)。 */
export interface RuntimeTunnelRegisterMessage {
  type: "register";
  runtimeType: string;
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

// 注意:本文件只放类型。隧道关闭码 RUNTIME_TUNNEL_CLOSE_GONE 是运行时值,
// 内联在 protocol/index.ts(shared 源码直连消费,跨文件 re-export 值会 ERR_MODULE_NOT_FOUND)。
