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
 * 一次 run 的 token 用量，在 API 侧从 `RUN_FINISHED.result` 归一化得到。
 * Claude / Codex 两个 adapter 上报的字段名不同，由 API 侧 WorkerEventProcessor 统一到这里。
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

// ── RuntimePlacement ──────────────────────────────────────────────────────

/** Runtime 隔离粒度：user（按用户隔离）或 workspace（按工作空间隔离）。 */
export type IsolationScope = "user" | "workspace";

/**
 * 沙箱专属放置信息：隔离粒度、容器内挂载目标、沙箱引擎类型。
 * 仅 runtimeType="sandbox" 时存在；local 模式无容器隔离语义，不带此对象。
 */
export type SandboxPlacementInfo = {
  isolationScope: IsolationScope;
  /** 容器/沙箱内 hostPath 的挂载目标路径（如 `/workspace` 或 `/workspaces`）。 */
  mountTarget: string;
  sandboxEngineType: "docker" | "opensandbox";
};

/**
 * 一次 run 的 runtime 放置信息：使用哪种 provider、host/容器侧的 workspace 路径。
 *
 * 判别联合，discriminant 为 `runtimeType`：sandbox 分支带 `sandbox` 对象（隔离粒度、
 * 挂载目标、引擎类型），local 分支不带。`runtimePath` 跨 local/sandbox 都有意义
 * （worker 在执行环境内看到的 workspace 路径），留顶层。
 *
 * sandbox-only 的函数/方法可直接以 `SandboxRuntimePlacement` 为入参——类型上 `sandbox` 必填，
 * 无需运行时守卫；`if (placement.runtimeType === "sandbox")` 后 TS 也会自动 narrow。
 */
export type LocalRuntimePlacement = {
  runtimeType: "local";
  userId: string;
  workspaceId: string;
  hostPath: string;
  runtimePath: string;
};

export type SandboxRuntimePlacement = {
  runtimeType: "sandbox";
  userId: string;
  workspaceId: string;
  hostPath: string;
  runtimePath: string;
  sandbox: SandboxPlacementInfo;
};

export type RuntimePlacement = LocalRuntimePlacement | SandboxRuntimePlacement;

// ── WorkerExecutionHandle / RuntimeTarget ───────────────────────────
// worker↔api 主路径上传递的 run/资源句柄。Runtime resource preparation and
// worker execution are split at the service boundary:
// RuntimeService.resolveRuntimeTarget() returns RuntimeTarget, while
// startWorkerExecution() starts/attaches a per-run worker session.
//
// 注：API 进程内的 provider 抽象（RuntimeProvider）与事件回调端口（RunEventReceiver）
// 不是跨进程线缆协议，定义在 apps/api/src/runtime 下，不在此处。

/** 一次 run 的 worker/session 执行句柄。 */
export interface WorkerExecutionHandle {
  runId: string;
  runtimeType: string;
  runtimeInstanceId: string;
  conversationId: string;
}

/**
 * 一次 run 的目标运行环境：放置方案 + ownerId（容器归属者 ID）。
 *
 * ownerId 是这个持久容器归属的 owner 的 ID：
 *   - user 隔离 → userId
 *   - workspace 隔离 → workspaceId
 * 一个 ownerId 对应一个可复用的容器实例（同一 owner 的多个 run 共用一个容器）。
 * 它承担容器命名、控制队列分区、access key 索引等职责，
 * 必须在 runtimeInstanceId 生成之前就稳定可用。
 */
export type RuntimeTarget = RuntimePlacement & { ownerId: string };

export type WorkerExecutionStartInput = {
  runtimeTarget: RuntimeTarget;
  runConfig: RunConfig;
  onRuntimeInstanceIdReady?: (runtimeInstanceId: string) => void;
};
