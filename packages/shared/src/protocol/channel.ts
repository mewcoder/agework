import type { BaseEvent } from "@ag-ui/core";
import type { AgentType, PendingAction, RunStatus } from "../common";
import type { RunChannelMessage } from "./run-channel-message";
import type { AgentEventTraceConfig, AgentEventTracePayload } from "./trace";

export type { AgentType, RunStatus };

/** AG-UI 事件，作为 `agui.event` 消息的 payload。 */
export type AGUIEvent = BaseEvent;

export type RunStatusPayload = {
  status: RunStatus;
  phase?: string;
  error?: string;
  /** status === "requires_action" 时，说明在等待什么操作；resolve 后置回 null。 */
  pendingAction?: PendingAction;
};

/**
 * 一次 run 的 token 用量。Claude / Codex 两个 SDK 上报的字段名不同，各自的
 * adapter（packages/adapters 的 `toRunUsage`）在 emit `RUN_FINISHED` 前
 * 归一化到这个形状；API 侧只做一次轻量运行时校验，不再猜字段名。
 */
export interface RunUsage {
  inputTokens: number;
  outputTokens: number;
  /** codex `cached_input_tokens` / claude `cache_read_input_tokens`。 */
  cachedInputTokens: number;
  /** codex `reasoning_output_tokens`；claude 无此字段，填 0。 */
  reasoningOutputTokens: number;
  /** claude `cache_creation_input_tokens`；codex 无此字段，填 0。 */
  cacheCreationInputTokens: number;
  /** 仅 claude 由 SDK 直接给出（`total_cost_usd`）；codex 为 null。 */
  totalCostUsd: number | null;
  numTurns: number;
  /** adapter 上报的纯 API 耗时（ms）。无值时为 null。 */
  durationApiMs: number | null;
}

export type ArtifactRefPayload = {
  artifactId: string;
  kind: string;
  uri: string;
};

/**
 * worker 启动时通过 `fetchRunConfig()` 拉取的运行配置。
 * `runtimePath` 由 RuntimeProvider.prepareRun 解析得到（直接用 / mount），
 * worker 不关心它是本机真实路径还是容器内 `/workspace`。
 */
export type RunConfig = {
  runId: string;
  conversationId: string;
  workspaceId: string;
  runtimePath: string;
  env: Record<string, string>;
  /** 传给 Agent Adapter 的原始 run input（如 AG-UI RunAgentInput）。 */
  input: unknown;
  agentProviderConfig: AgentProviderConfig;
  agentEventTrace?: AgentEventTraceConfig;
  workerLogFilePath?: string;
  /** native runtime 从 envConfig 提取的 CLI 路径（override > detected）。container 不填。 */
  claudeExecutablePath?: string;
  /** native runtime 从 envConfig 提取的 CLI 路径（override > detected）。container 不填。 */
  codexExecutablePath?: string;
};

/**
 * Agent provider 运行时配置（API → worker 下发）。
 * 用判别式联合区分两种来源：
 * - 系统配置：配置由本地 CLI 文件提供（~/.claude.json 等），无需任何参数。
 * - 自定义配置：由用户保存的 ModelProvider 提供四个统一字段。
 */
export type SystemAgentProviderConfig = {
  agentType: AgentType;
  source: "system";
};

export type CustomAgentProviderConfig = {
  agentType: AgentType;
  source: "custom";
  baseUrl: string;
  apiKey: string;
  /** API 在 build provider config 阶段已解析好的单模型。 */
  model: string;
  /** 补充项：Claude 注入为子进程环境变量、Codex 合并进 --config。 */
  extraConfig?: Record<string, string>;
};

export type AgentProviderConfig =
  | SystemAgentProviderConfig
  | CustomAgentProviderConfig;

/** 控制面 → worker 的下行命令消息。 */
export type CommandPayload =
  | { type: "cancel"; commandId: string; runId: string; conversationId: string }
  | { type: "interrupt"; commandId: string; runId?: string }
  | {
      type: "approval_resolved";
      commandId: string;
      conversationId: string;
      answers: Record<string, string | string[]>;
    }
  | {
      type: "user_message";
      commandId: string;
      /** 本次 turn 的 runId（worker 用它来 emit 事件和上报状态）。 */
      runId: string;
    };

/**
 * worker → 控制面的命令处理 trace 上报。
 * 用于命令闭环追踪：收到命令时上报 received，处理完成/失败上报 handled/failed。
 * commandId 用于和 API 侧 command.sent trace 回连。
 */
export type CommandTracePayload = {
  /** received / handled / failed */
  phase: "received" | "handled" | "failed";
  /** 对应下行命令的 commandId。 */
  commandId: string;
  /** 下行命令的 type（cancel/interrupt/approval_resolved/user_message）。 */
  commandType: string;
  /** 处理失败时的错误信息（仅 phase=failed）。 */
  error?: string;
};

/**
 * worker → 控制面的正式命令处理结果。
 * `command.trace` 继续作为 timeline/diagnostics；业务闭环看 `command.result`。
 */
export type CommandResultPayload = {
  commandId: string;
  commandType: CommandPayload["type"];
  status: "ok" | "error";
  error?: string;
};

/** worker → 控制面的上行消息集合（`run.status` / `agui.event` / `sdk.raw` / `artifact.ref` / `command.trace` / `command.result`）。 */
export type UpstreamMessage =
  | RunChannelMessage<RunStatusPayload>
  | RunChannelMessage<AGUIEvent>
  | RunChannelMessage<AgentEventTracePayload>
  | RunChannelMessage<ArtifactRefPayload>
  | RunChannelMessage<CommandTracePayload>
  | RunChannelMessage<CommandResultPayload>;

export type Unsubscribe = () => void;

/**
 * 单 run worker 依赖的通信接口，由 `IpcChannel`（process.send/on('message')）实现。
 * 持久容器 worker 不走此接口；下行命令由 owner-scoped command loop 拉取，
 * 上行事件和 run config 由 run-scoped HTTP client 按 runId 参数化收发。
 */
export interface RuntimeChannel {
  fetchRunConfig(): Promise<RunConfig>;
  emit(msg: UpstreamMessage): Promise<void>;
  subscribeCommands(cb: (command: RunChannelMessage<CommandPayload>) => void): Unsubscribe;
  close(): Promise<void>;
}

// ── RuntimeSpec ──────────────────────────────────────────────────────

/** Runtime 隔离粒度：user（按用户隔离）或 workspace（按工作空间隔离）。 */
export type IsolationScope = "user" | "workspace";

/**
 * 沙箱专属放置信息：隔离粒度、容器内挂载目标、沙箱引擎类型。
 * 仅 runtimeType 为 container（docker|opensandbox）时存在；native 模式无容器隔离语义，不带此对象。
 */
export type SandboxPlacementInfo = {
  isolationScope: IsolationScope;
  /** 容器/沙箱内 hostPath 的挂载目标路径（如 `/workspace` 或 `/workspaces`）。 */
  mountTarget: string;
};

/**
 * 一次 run 已解析的 runtime 规格：workspace 怎么挂进运行环境（host/容器侧路径 + 挂载点）
 * + ownerId（容器归属/复用键）。启动前纯计算,provider 照此挂卷/起容器。
 *
 * 判别联合，discriminant 为 `runtimeType`：container（docker|opensandbox）分支带 `sandbox`
 * 对象，native 分支不带。`runtimePath` 跨 native/container 都有意义（worker 在执行环境内看到的
 * workspace 路径），留顶层。container-only 逻辑可直接以 `SandboxRuntimeSpec` 为入参。
 *
 * ownerId：user 隔离→userId，workspace 隔离/native→workspaceId。一个 ownerId 对应一个可复用
 * 容器（同 owner 多 run 共用），承担容器命名/队列分区等，须早于 runtimeInstanceId 稳定。
 */
export type NativeRuntimeSpec = {
  runtimeType: "native";
  userId: string;
  workspaceId: string;
  hostPath: string;
  runtimePath: string;
  /** 日志目录在执行环境内的路径(native 下即宿主机日志目录)。 */
  runtimeLogDir: string;
  ownerId: string;
};

export type SandboxRuntimeSpec = {
  runtimeType: "docker" | "opensandbox";
  userId: string;
  workspaceId: string;
  hostPath: string;
  runtimePath: string;
  /** 日志目录在执行环境内的路径(sandbox 下为容器内挂载点)。 */
  runtimeLogDir: string;
  sandbox: SandboxPlacementInfo;
  ownerId: string;
};

export type RuntimeSpec = NativeRuntimeSpec | SandboxRuntimeSpec;

// ── WorkerExecutionHandle / RuntimeSpec ───────────────────────────
// worker↔api 主路径上传递的 run/资源句柄。Runtime resource preparation and
// worker execution are split at the service boundary:
// RuntimeService.resolveRuntimeSpec() returns RuntimeSpec, while
// startWorkerExecution() starts/attaches a per-run worker session.
//
// 注：API 进程内的 provider 抽象（RuntimeProvider）与事件回调端口（RunEventReceiver）
// 不是跨进程线缆协议，定义在 apps/server/src/runtime 下，不在此处。

/** 一次 run 的 worker/session 执行句柄。 */
export interface WorkerExecutionHandle {
  runId: string;
  runtimeType: string;
  runtimeInstanceId: string;
  conversationId: string;
}

export type WorkerExecutionStartInput = {
  runtimeTarget: RuntimeSpec;
  runConfig: RunConfig;
  onRuntimeInstanceIdReady?: (runtimeInstanceId: string) => void;
  /** 目标 Runtime id(managed 本机内置 或 registered 远程机器)。不进 RuntimeSpec——
   *  那是纯 DB 无关的 placement 计算类型,这个字段来自 workspace.runtimeId,是
   *  "起在哪台机器上"而非"怎么挂载/隔离"。 */
  targetRuntimeId: string;
};

/**
 * runtime 为一次 run 取得（创建/复用/attach）持久容器实例的结果。
 * runtime 退成纯资源层，把就绪/失败两类事实一次性回传 run 层执行编排：
 *   - ready：容器就绪，附带 runtimeInstanceId（run 据此自行 openSession）
 *   - error：容器创建/启动失败
 * 取消请求早于容器就绪到达时，run 层在 ready 分支通过自身 state.cancelled 自处理。
 */
export type AcquireInstanceResult =
  | { outcome: "ready"; workerId: string; runtimeInstanceId: string }
  | { outcome: "error"; error: string };

/**
 * worker 进程启动后向 `POST /worker/:workerId/register` 发起的注册握手请求体。
 * startToken 由 server 在 launch 时下发（env `AGEWORK_WORKER_START_TOKEN`），worker
 * 原样带回以证明自己是 server 期望的那个进程/容器。
 */
export type WorkerRegisterRequest = {
  startToken: string;
  pid?: number;
  /** worker 产物版本(来自 bundled `AGEWORK_VERSION`),server 用于握手比对告警。 */
  version?: string;
};
