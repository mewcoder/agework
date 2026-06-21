/**
 * AG-UI integration for OpenAI Codex Agent SDK.
 *
 * @example
 * ```typescript
 * import { CodexAgentAdapter } from "./libs/ag-ui-codex-agent-sdk";
 *
 * const adapter = new CodexAgentAdapter({
 *   model: "o4-mini",
 *   sandboxMode: "workspace-write",
 *   workingDirectory: "/path/to/project",
 * });
 * const events$ = adapter.run(input);
 * ```
 */

export { CodexAgentAdapter } from "./adapter";
export type {
  AgentTraceEvent,
  AgentTraceSink,
  CodexAgentAdapterConfig,
  CodexClientLike,
  CodexThreadLike,
  ProcessedEvent,
} from "./types";
export { ALLOWED_FORWARDED_PROPS } from "./config";
