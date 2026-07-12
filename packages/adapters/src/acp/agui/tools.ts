import type {
  ToolCallContent,
  ToolKind,
} from "@agentclientprotocol/sdk";
import { contentBlockText } from "./content";

const KNOWN_KINDS: ReadonlySet<string> = new Set<ToolKind>([
  "read",
  "edit",
  "delete",
  "move",
  "search",
  "execute",
  "think",
  "fetch",
  "switch_mode",
  "other",
]);

/**
 * Canonical AG-UI tool name for an ACP tool call. Prefers the stable `kind`;
 * unknown/absent kinds map to `acp_tool` (doc §12.5). The human-readable `title`
 * is carried in the args, not used as the protocol name.
 */
export function acpToolName(kind?: ToolKind | null): string {
  return kind && KNOWN_KINDS.has(kind) ? kind : "acp_tool";
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** Build the AG-UI `TOOL_CALL_ARGS` payload from an ACP tool call. */
export function toolArgs(input: {
  title?: string | null;
  kind?: ToolKind | null;
  rawInput?: unknown;
}): string {
  const base: Record<string, unknown> = {};
  if (input.title) base.title = input.title;
  if (input.kind) base.kind = input.kind;
  if (input.rawInput !== undefined && input.rawInput !== null) {
    if (typeof input.rawInput === "object") {
      Object.assign(base, input.rawInput as Record<string, unknown>);
    } else {
      base.input = input.rawInput;
    }
  }
  return stringify(base);
}

/** Extract a text descriptor from an ACP tool result content block. */
function toolContentText(content: ToolCallContent): string {
  switch (content.type) {
    case "content":
      return contentBlockText(content.content);
    case "diff":
      return `[diff ${content.path}]`;
    case "terminal":
      return `[terminal ${content.terminalId}]`;
    default:
      return "";
  }
}

/** Build the AG-UI `TOOL_CALL_RESULT` payload from an ACP tool result. */
export function toolResult(input: {
  content?: ToolCallContent[] | null;
  rawOutput?: unknown;
  error?: string;
}): string {
  if (input.error) return input.error;
  if (input.rawOutput !== undefined && input.rawOutput !== null) {
    return stringify(input.rawOutput);
  }
  if (input.content && input.content.length > 0) {
    return input.content.map(toolContentText).filter(Boolean).join("\n");
  }
  return "";
}
