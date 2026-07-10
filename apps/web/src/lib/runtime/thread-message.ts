import type { ThreadMessage } from "@assistant-ui/react";
import { AG_UI_METADATA_NAMESPACE } from "@assistant-ui/react-ag-ui";
import type { StoredMessage } from "@/api/conversations";
import { isPlainObject } from "lodash-es";

export type ThreadMessageItem = {
  parentId: string | null;
  message: ThreadMessage;
};

function normalizeContent(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string" && raw) return [{ type: "text", text: raw }];
  return [];
}

function normalizeCreatedAt(raw: unknown): Date | undefined {
  if (raw instanceof Date) return raw;
  if (typeof raw !== "string") return undefined;

  const createdAt = new Date(raw);
  return Number.isNaN(createdAt.getTime()) ? undefined : createdAt;
}

function assistantMetadata() {
  return {
    unstable_state: null,
    unstable_annotations: [],
    unstable_data: [],
    steps: [],
    custom: {},
  };
}

export function toThreadMessageItem(m: StoredMessage): ThreadMessageItem | null {
  if (!isPlainObject(m.content) || m.content.role === "tool") return null;

  const message: Record<string, unknown> = {
    ...m.content,
    id: typeof m.content.id === "string" ? m.content.id : m.id,
    content: normalizeContent(m.content.content),
    createdAt: normalizeCreatedAt(m.content.createdAt),
  };

  if (message.role === "assistant") {
    message.status = message.status ?? { type: "complete", reason: "unknown" };
    const metadata =
      (message.metadata as Record<string, unknown> | undefined) ??
      assistantMetadata();
    // 冷加载注入上下文占用到 custom.agui，与 live（run-aggregator）同一位置。
    if (m.contextUsage) {
      const custom: Record<string, unknown> = isPlainObject(metadata.custom)
        ? { ...(metadata.custom as Record<string, unknown>) }
        : {};
      const agui = isPlainObject(custom[AG_UI_METADATA_NAMESPACE])
        ? (custom[AG_UI_METADATA_NAMESPACE] as Record<string, unknown>)
        : {};
      custom[AG_UI_METADATA_NAMESPACE] = {
        ...agui,
        contextUsage: m.contextUsage,
      };
      metadata.custom = custom;
    }
    message.metadata = metadata;
  } else {
    delete message.status;
  }

  return { parentId: m.parent_id, message: message as ThreadMessage };
}

export function isThreadMessageItem(
  item: ThreadMessageItem | null,
): item is ThreadMessageItem {
  return item !== null;
}
