import type { BaseEvent } from "@ag-ui/core";
import type { AgentType, PendingAction, RunStatus } from "../common";
import type { Envelope } from "./envelope";
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
 * Claude / Codex 两个 adapter 上报的字段名不同（见 `normalizeRunUsage`），统一到这里。
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

export type HeartbeatPayload = {
  at: string;
};

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

/** 控制面 → worker 的下行控制消息。 */
export type ControlPayload =
  | { type: "cancel"; commandId: string; runId: string; conversationId: string }
  | { type: "interrupt"; commandId: string }
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
      /** 传给 adapter.run() 的完整 input（AG-UI RunAgentInput）。 */
      input: unknown;
    };

/**
 * worker → 控制面的 control 处理 trace 上报。
 * 用于 control 闭环追踪：收到 control 时上报 received，处理完成/失败上报 handled/failed。
 * commandId 用于和 API 侧 control.enqueued trace 回连。
 */
export type ControlTracePayload = {
  /** received / handled / failed */
  phase: "received" | "handled" | "failed";
  /** 对应下行 control 的 commandId。 */
  commandId: string;
  /** 下行 control 的 type（cancel/interrupt/approval_resolved/user_message）。 */
  controlType: string;
  /** 处理失败时的错误信息（仅 phase=failed）。 */
  error?: string;
};

/** worker → 控制面的上行消息集合（`run.status` / `agui.event` / `sdk.raw` / `heartbeat` / `artifact.ref` / `control.trace`）。 */
export type UpstreamMessage =
  | Envelope<RunStatusPayload>
  | Envelope<AGUIEvent>
  | Envelope<AgentEventTracePayload>
  | Envelope<HeartbeatPayload>
  | Envelope<ArtifactRefPayload>
  | Envelope<ControlTracePayload>;

export type Unsubscribe = () => void;

/**
 * worker 主体唯一依赖的通信接口。`IpcTransport`（本轮，process.send/on('message')）
 * 与 `HttpTransport`（下一轮，POST /events + 轮询 /controls）都实现此接口，
 * 对 worker 和 Agent Adapter 透明。
 */
export interface RuntimeTransport {
  fetchRunConfig(): Promise<RunConfig>;
  emit(msg: UpstreamMessage): Promise<void>;
  subscribeControls(cb: (control: Envelope<ControlPayload>) => void): Unsubscribe;
  close(): Promise<void>;
}

// ── RuntimePlacement ──────────────────────────────────────────────────────

/** Runtime 隔离粒度：user（按用户隔离）或 workspace（按工作空间隔离）。 */
export type IsolationScope = "user" | "workspace";

/**
 * 一次 run 的 runtime 放置信息：使用哪种 provider、隔离粒度，
 * 以及 host/容器侧的 workspace 路径。
 *
 * `mountTarget` 是隔离粒度的派生值，由放置服务一次性算好。
 */
export type RuntimePlacement = {
  runtimeType: string;
  isolationScope: IsolationScope;
  userId: string;
  workspaceId: string;
  hostPath: string;
  runtimePath: string;
  /** 容器/沙箱内 hostPath 的挂载目标路径（如 `/workspace` 或 `/workspaces`）。 */
  mountTarget: string;
  /** sandbox engine 类型，仅 runtimeType="sandbox" 时有值。 */
  sandboxEngineType?: "docker" | "opensandbox";
};

// ── RuntimeProvider / RuntimeHandle ──────────────────────────────────────────
// API 控制面侧的 provider 抽象。LocalProcessProvider（fork）与
// DockerProvider（docker run）都实现此接口，对 AgentController 透明。

/** Provider 返回的运行句柄。不含实现细节（child process / container），
 *  那些由 provider 在内部维护。`runtimeResourceId` 必须可持久化到 Run 表。 */
export interface RuntimeHandle {
  runId: string;
  runtimeType: string;
  runtimeResourceId: string;
  conversationId: string;
}

/** API 控制面侧的 provider 接口。 */
export interface RuntimeProvider {
  readonly type: string;
  /**
   * 启动 worker。`runtimeResourceId` 可能在返回时尚未就绪（如 DockerProvider 的容器 ID
   * 是异步获取的）；此时返回的 handle.runtimeResourceId 为空字符串，
   * 待就绪后通过 onRuntimeResourceIdReady 通知调用方持久化。
   */
  start(
    runConfig: RunConfig,
    placement: RuntimePlacement,
    onRuntimeResourceIdReady?: (runtimeResourceId: string) => void
  ): RuntimeHandle;
  sendControl(handle: RuntimeHandle, control: ControlPayload): void;
  cancel(handle: RuntimeHandle): void;
  getHandle(runId: string): RuntimeHandle | undefined;
  /** 收到 worker 心跳时调用，重置该 run 的心跳 watchdog 计时。 */
  heartbeat(runId: string): void;
  /** Run 终态后清理 provider 内部状态（心跳定时器等）。幂等。 */
  cleanup(runId: string): void;
  /** 服务重启后，根据持久化的 runtimeResourceId 终止孤儿 run 对应的进程/容器。幂等。 */
  recoverOrphan(runtimeResourceId: string): Promise<void>;
  /** 收到 worker 心跳时喂 workspace/容器级 watchdog。 */
  heartbeatWorkspace?(workspaceId: string): void;
  /** 收到 worker 心跳时按 runtime resource key 喂容器级 watchdog。 */
  heartbeatRuntimeResource?(resourceKey: string): void;
  /** 停止并删除指定 runtime resource key 对应的持久容器/沙箱。 */
  shutdownRuntimeResource?(resourceKey: string): void;
}
