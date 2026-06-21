import type { AgentConfig } from "@ag-ui/client";
import type {
  RunStartedEvent,
  RunFinishedEvent,
  RunErrorEvent,
  TextMessageStartEvent,
  TextMessageContentEvent,
  TextMessageEndEvent,
  ToolCallStartEvent,
  ToolCallArgsEvent,
  ToolCallEndEvent,
  ToolCallResultEvent,
  ReasoningStartEvent,
  ReasoningMessageStartEvent,
  ReasoningMessageContentEvent,
  ReasoningMessageEndEvent,
  ReasoningEndEvent,
  StateSnapshotEvent,
  MessagesSnapshotEvent,
  CustomEvent,
} from "@ag-ui/core";
import type {
  SandboxMode,
  ModelReasoningEffort,
  WebSearchMode,
  ApprovalMode,
  ThreadOptions,
  TurnOptions,
  Input,
  RunStreamedResult,
} from "@openai/codex-sdk";
import type { AgentTraceEvent, AgentTraceSink } from "@agework/shared/protocol";

export type { AgentTraceEvent, AgentTraceSink };

/** Duck type for a Codex thread — only the methods the adapter calls. */
export type CodexThreadLike = {
  runStreamed(input: Input, options?: TurnOptions): Promise<RunStreamedResult>;
};

/** Duck type for a Codex client — enables mock injection for testing. */
export type CodexClientLike = {
  startThread(options?: ThreadOptions): CodexThreadLike;
  resumeThread(id: string, options?: ThreadOptions): CodexThreadLike;
};

/** Mirrors CodexConfigObject from @openai/codex-sdk (not publicly exported). */
export type CodexConfigValue =
  | string
  | number
  | boolean
  | CodexConfigValue[]
  | CodexConfigObject;
export type CodexConfigObject = { [key: string]: CodexConfigValue };


/**
 * Configuration for CodexAgentAdapter.
 *
 * Combines AG-UI AgentConfig with Codex SDK options.
 * Set OPENAI_API_KEY (or CODEX_API_KEY) via environment variable or pass apiKey directly.
 *
 * @example
 * ```typescript
 * const adapter = new CodexAgentAdapter({
 *   model: "o4-mini",
 *   sandboxMode: "workspace-write",
 *   workingDirectory: "/path/to/project",
 *   instructions: "You are a helpful coding assistant.",
 * });
 * ```
 */
export type CodexAgentAdapterConfig = AgentConfig & {
  /** Path to the codex CLI binary. Auto-resolved from @openai/codex if not provided. */
  codexPathOverride?: string;
  /** OpenAI base URL override. */
  baseUrl?: string;
  /** OpenAI / Codex API key. Defaults to OPENAI_API_KEY env var. */
  apiKey?: string;
  /** Environment variables for the codex subprocess. Defaults to inheriting process.env. */
  env?: Record<string, string>;
  /** Additional --config key=value overrides for the Codex CLI. */
  config?: CodexConfigObject;
  /** System prompt / instructions injected via --config instructions. */
  instructions?: string;
  /**
   * Override the Codex client — useful for testing without spawning a real process.
   * When provided, codexPathOverride/apiKey/baseUrl/env/config are ignored.
   */
  codexClient?: CodexClientLike;
  /** Optional local trace hook for raw Codex request/response diagnostics. */
  trace?: AgentTraceSink;

  // ThreadOptions fields (per-thread defaults, overridable via forwardedProps)
  model?: string;
  sandboxMode?: SandboxMode;
  workingDirectory?: string;
  skipGitRepoCheck?: boolean;
  modelReasoningEffort?: ModelReasoningEffort;
  networkAccessEnabled?: boolean;
  webSearchMode?: WebSearchMode;
  webSearchEnabled?: boolean;
  approvalPolicy?: ApprovalMode;
  approvalsReviewer?: "user" | "auto_review";
  additionalDirectories?: string[];
};

export type ProcessedEvent =
  | RunStartedEvent
  | RunFinishedEvent
  | RunErrorEvent
  | TextMessageStartEvent
  | TextMessageContentEvent
  | TextMessageEndEvent
  | ToolCallStartEvent
  | ToolCallArgsEvent
  | ToolCallEndEvent
  | ToolCallResultEvent
  | ReasoningStartEvent
  | ReasoningMessageStartEvent
  | ReasoningMessageContentEvent
  | ReasoningMessageEndEvent
  | ReasoningEndEvent
  | StateSnapshotEvent
  | MessagesSnapshotEvent
  | CustomEvent;
