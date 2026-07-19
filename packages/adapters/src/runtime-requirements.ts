import type { AgentRuntimeRequirements } from "@agework/agent-sdk";

/** Managed Runtime dependencies for the bundled Claude and Codex adapters. */
export const BUILTIN_AGENT_RUNTIME_REQUIREMENTS = {
  claude: {
    npmPackages: {
      "@anthropic-ai/claude-agent-sdk": "0.3.207",
    },
  },
  codex: {
    npmPackages: {
      "@openai/codex-sdk": "0.144.1",
    },
  },
} as const satisfies AgentRuntimeRequirements;
