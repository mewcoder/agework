export {
  ClaudeAgentAdapter,
  resolveQuestion,
  cancelQuestion,
  type ClaudeAdapterConfig,
  type AgentPendingAction,
  type AgentPendingActionSink,
} from "./claude/business/claude-agent.adapter";

export {
  CodexAgentAdapter,
  type CodexAdapterConfig,
} from "./codex/business/codex-agent.adapter";

export {
  createCodexAdapter,
  type CodexAgentInstance,
  type CodexBackendConfig,
} from "./codex/factory";
