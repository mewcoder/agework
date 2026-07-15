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

/**
 * 一次 run 结束时的上下文窗口占用。与 {@link RunUsage} 同理，两个 SDK 各自的
 * 字段名不同，adapter 归一化到这个形状后挂在 `RUN_FINISHED.result.contextUsage`。
 * Claude 由 SDK `getContextUsage()` 直接给出真窗口（含 1M beta，无需静态表）；
 * Codex 后续从事件流的 `model_context_window` + token count 填充。
 */
export interface AgentContextUsage {
  /** 当前已占用的上下文 token 数。claude `totalTokens`。 */
  usedTokens: number;
  /** 有效上下文窗口（已扣除输出预留）。claude `maxTokens`。 */
  maxTokens: number;
  /** 占用百分比（0-100）。claude 由 SDK 直接给出。 */
  percentage: number;
  /** 触发自动压缩的阈值 token 数；SDK 未启用/未给出时省略。 */
  autoCompactThreshold?: number;
  /** 本轮 token 明细（context meter hover 卡用），来自 result.usage。 */
  inputTokens?: number;
  outputTokens?: number;
  /** cache_read + cache_creation。 */
  cachedInputTokens?: number;
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
  /** native runtime 从 envConfig 提取的 CLI 路径（override > detected）。container 不填。 */
  opencodeExecutablePath?: string;
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
  | { type: "interrupt"; commandId: string; runId: string }
  | {
      type: "approval_resolved";
      commandId: string;
      /** 全链路唯一命令路由键。Worker 不按 conversationId 维护业务索引。 */
      runId: string;
      conversationId: string;
      /**
       * Provider-agnostic opaque payload（【决策2】 generalized resume contract）.
       *
       * - Claude 问答: `{ answers: Record<string, string | string[]> }`
       * - Codex 命令/文件审批: `{ decision: "accept"|"acceptForSession"|"decline"|"cancel" }`
       * - Codex 权限审批: `{ permissions: ..., scope: "turn"|"session" }`
       * - 取消: `{ status: "cancelled" }`
       */
      payload: unknown;
      /** 续接 run 的 AG-UI runId:adapter 解开挂起后用它发 RUN_STARTED,把后续事件归入新 run。 */
      resumeRunId?: string;
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

/**
 * 上行消息的 producer 入参:只带业务事件（type + payload），信封字段
 * （runId / seq / ts）由 transport 在 emit 时盖章，producer 不接触。
 * 逐成员 Omit 以保住 type↔payload 配对。
 */
export type UpstreamMessageInput = UpstreamMessage extends infer M
  ? M extends RunChannelMessage
    ? Omit<M, "runId" | "seq" | "ts">
    : never
  : never;

export type Unsubscribe = () => void;

/**
 * 单 run worker 依赖的通信接口，由 `IpcChannel`（process.send/on('message')）实现。
 * 持久容器 worker 不走此接口；下行命令由 owner-scoped command loop 拉取，
 * 上行事件和 run config 由 run-scoped HTTP client 按 runId 参数化收发。
 */
export interface RunChannel {
  fetchRunConfig(): Promise<RunConfig>;
  emit(msg: UpstreamMessageInput): Promise<void>;
  subscribeCommands(
    cb: (command: RunChannelMessage<CommandPayload>) => void
  ): Unsubscribe;
  close(): Promise<void>;
}

// ── RuntimeSpec ──────────────────────────────────────────────────────

/** Worker 复用范围：user（用户范围）或 workspace（工作空间范围）。 */
export type WorkerScope = "user" | "workspace";

/**
 * 沙箱专属放置信息：复用范围、容器内挂载目标、沙箱引擎类型。
 * 仅 runtimeType 为 container（docker|opensandbox）时存在；native 模式无 sandbox scope，不带此对象。
 */
export type SandboxPlacementInfo = {
  scope: WorkerScope;
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
 * ownerId：user scope → userId，workspace scope / native → workspaceId。一个 ownerId 对应一个可复用
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

// ── RunExecutionHandle ────────────────────────────────────────────

/** Server 侧一次 run 的最小执行路由句柄，不暴露 worker/容器实例细节。 */
export interface RunExecutionHandle {
  runId: string;
  runtimeHostId: string;
  runtimeType: string;
  conversationId: string;
}

/**
 * worker 进程启动后向 `POST /worker/:workerId/register` 发起的注册握手请求体。
 * startToken 由 server 在 launch 时下发（env `AGEWORK_WORKER_START_TOKEN`），worker
 * 原样带回以证明自己是 server 期望的那个进程/容器。
 */
export type WorkerRegisterRequest = {
  startToken: string;
  pid?: number;
  /** Host ↔ Worker HTTP 线协议版本。缺失或不匹配都拒绝注册。 */
  protocolVersion: number;
  /** Worker 产物版本(来自 bundled `AGEWORK_VERSION`),Host 用于握手比对告警。 */
  version?: string;
};
