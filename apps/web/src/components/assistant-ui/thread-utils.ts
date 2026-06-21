import {
  type ToolCallMessagePart,
  type ToolCallMessagePartStatus,
} from "@assistant-ui/react";

/** Tool-call part with runtime status (from MessagePartState) */
export type ToolCallPart = ToolCallMessagePart & {
  toolUI?: React.ComponentType<ToolCallMessagePartProps>;
  status?: ToolCallMessagePartStatus;
};

type ToolCallMessagePartProps = ToolCallPart & {
  addResult?: (result: unknown) => void;
};

export type GroupableMessagePart =
  | { type: "text"; parentId?: string; text?: string }
  | { type: "reasoning"; parentId?: string; text?: string }
  | ToolCallPart
  | { type: string; [key: string]: unknown }; // catch-all for source/file/image/data etc.

export type ToolCallBatch = {
  toolName: string;
  parts: ToolCallPart[];
};

export function getProcessTitleTextParts(parts: readonly GroupableMessagePart[]) {
  const processTitleTextParts = new WeakSet<GroupableMessagePart>();
  const pendingTextParts: GroupableMessagePart[] = [];
  let hasProcessText = false;

  for (const part of parts) {
    if (part.type === "text") {
      pendingTextParts.push(part);
      continue;
    }

    if (part.type === "tool-call" && part.parentId) {
      for (const textPart of pendingTextParts) {
        processTitleTextParts.add(textPart);
        hasProcessText = true;
      }
      pendingTextParts.length = 0;
    }
  }

  return hasProcessText ? processTitleTextParts : null;
}

export function isToolCallPart(p: GroupableMessagePart): p is ToolCallPart {
  return p.type === "tool-call";
}

export function groupConsecutiveSameTool(
  parts: readonly GroupableMessagePart[],
  indices: readonly number[],
): ToolCallBatch[] {
  const batches: ToolCallBatch[] = [];

  for (const idx of indices) {
    const part = parts[idx];
    if (!part || !isToolCallPart(part)) continue;
    const last = batches[batches.length - 1];
    if (last?.toolName === part.toolName) {
      last.parts.push(part);
    } else {
      batches.push({ toolName: part.toolName, parts: [part] });
    }
  }

  return batches;
}

export function aggregateToolStatus(parts: ToolCallPart[]): ToolCallMessagePartStatus | undefined {
  let result: ToolCallMessagePartStatus | undefined;
  for (const p of parts) {
    const s = p.status;
    if (!s) continue;
    if (s.type === "running") return s;
    if (!result || result.type === "complete") result = s;
  }
  return result;
}

/** 是否有可展示内容（参数 / 结果 / 错误文本）。没有内容时工具卡片不允许展开。 */
export function hasToolContent(part: {
  argsText?: string;
  result?: unknown;
  status?: ToolCallMessagePartStatus;
}): boolean {
  if (part.argsText) return true;
  if (part.result !== undefined) return true;
  if (part.status?.type === "incomplete" && part.status.error) return true;
  return false;
}

/**
 * 扫描消息列表找出待回答的 AskUserQuestion/AskUserPermission part。
 * 后端串行化后同一时刻只有 1 个 running 的待答 part（权限审批或模型主动问答）。
 *
 * 权限审批这条合成工具调用收尾时会带上 TOOL_CALL_RESULT，所以一旦回答完，
 * part.result 被设置，status 会跟着变成 complete（见 assistant-ui
 * message-runtime 的 toMessagePartStatus：tool-call part 没有 result 时
 * status 跟随所在消息走，否则固定为 complete），不会再被这里命中。
 */
export function findPendingQuestionPart(
  messages: readonly { role: string; parts?: unknown }[],
): ToolCallPart | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || msg.role !== "assistant") continue;
    const parts = msg.parts;
    if (!Array.isArray(parts)) continue;
    for (let j = parts.length - 1; j >= 0; j--) {
      const part = parts[j] as ToolCallPart | undefined;
      if (!part || part.type !== "tool-call") continue;
      if (part.toolName !== "AskUserQuestion" && part.toolName !== "AskUserPermission") continue;
      const status = part.status as ToolCallMessagePartStatus | undefined;
      if (status?.type === "running") {
        return part;
      }
    }
  }
  return null;
}
