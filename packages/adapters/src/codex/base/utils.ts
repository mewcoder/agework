import type { RunAgentInput } from "@ag-ui/core";
import type { Usage } from "@openai/codex-sdk";
import type { RunUsage } from "@agework/shared/protocol";

/**
 * Check if a state value is meaningful (non-null, non-undefined).
 * Empty objects {} are treated as having state (same logic as claude adapter).
 */
export function hasState(state: unknown): boolean {
  if (state == null) return false;
  if (typeof state !== "object") return true;
  if (Array.isArray(state)) return state.length > 0;
  return true;
}

/**
 * Extract the last user message text from RunAgentInput.messages.
 */
export function processMessages(input: RunAgentInput): { userMessage: string } {
  const messages = input.messages ?? [];
  let userMessage = "";

  if (messages.length > 0) {
    const lastMsg = messages[messages.length - 1];
    const content = lastMsg.content;
    if (typeof content === "string") {
      userMessage = content;
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (typeof block === "object" && block !== null && "text" in block) {
          userMessage = (block as { text: string }).text;
          break;
        }
      }
    }
  }

  if (!userMessage) {
    console.warn(`[CodexAdapter] No user message found in ${messages.length} messages`);
  }

  return { userMessage };
}

/**
 * Build a state + context addendum to append to the Codex instructions.
 * Keeps state/context in the system prompt rather than polluting the user message.
 */
export function buildStateContextAddendum(input: RunAgentInput): string {
  const parts: string[] = [];

  if (input.context && input.context.length > 0) {
    parts.push("## Context from the application");
    for (const ctx of input.context) {
      parts.push(`- ${ctx.description}: ${ctx.value}`);
    }
    parts.push("");
  }

  if (hasState(input.state)) {
    parts.push("## Current Shared State");
    parts.push("This state is shared with the frontend UI.");
    try {
      parts.push(`\`\`\`json\n${JSON.stringify(input.state, null, 2)}\n\`\`\``);
    } catch {
      parts.push(`State: ${String(input.state)}`);
    }
    parts.push("");
  }

  return parts.join("\n");
}

/**
 * Map a Codex SDK turn usage onto the AG UI-agnostic `RunUsage` shape.
 * `totalCostUsd`/`durationApiMs`/`cacheCreationInputTokens` have no Codex equivalent.
 */
export function toRunUsage(usage: Usage, numTurns: number): RunUsage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cachedInputTokens: usage.cached_input_tokens,
    reasoningOutputTokens: usage.reasoning_output_tokens,
    cacheCreationInputTokens: 0,
    totalCostUsd: null,
    numTurns,
    durationApiMs: null,
  };
}
