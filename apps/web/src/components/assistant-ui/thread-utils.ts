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
 * 待答判定:问答走 AG-UI interrupt terminal model,问题挂起时消息状态是
 * requires-action(reason interrupt),没有 result 的 tool-call part 继承它
 * (assistant-ui message-runtime 的 toMessagePartStatus)。running 分支覆盖
 * 事件仍在流入的窗口期(RUN_FINISHED{interrupt} 尚未到达)。
 * 回答完成后 part.result 被设置,status 固定为 complete,不再命中。
 */
export function isAwaitingAnswerStatus(
  status: { type?: string } | undefined,
): boolean {
  return status?.type === "running" || status?.type === "requires-action";
}

/**
 * 扫描消息列表找出待回答的 AskUserQuestion/AskUserPermission part。
 * 后端串行化后同一时刻只有 1 个待答 part（权限审批或模型主动问答）。
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
      if (part.result === undefined && isAwaitingAnswerStatus(status)) {
        return part;
      }
    }
  }
  return null;
}
