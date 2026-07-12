import {
  type ToolCallMessagePart,
  type ToolCallMessagePartStatus,
} from "@assistant-ui/react";
import {
  readAgUiCustomMetadata,
  type AgUiInterrupt,
} from "@assistant-ui/react-ag-ui";

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

type ThreadMessageLike = {
  role: string;
  parts?: unknown;
  status?: { type?: string; reason?: string };
  metadata?: unknown;
};

/**
 * 待答问题的唯一描述。phase 对应问题挂起的两个可观察阶段:
 *  - streaming:TOOL_CALL_START/ARGS 已到、RUN_FINISHED{interrupt} 未到的窗口期。
 *    part 已存在(题目可渲染),但 interrupt id 还没写进消息 metadata——
 *    物理上无法提交,表单可填、提交必须禁用。
 *  - open:消息以 requires-action(reason interrupt) 收尾,metadata 里有带 id
 *    的 interrupt(权威状态),可提交。
 * 回答完成后 part.result 被跨段回填,不再命中任何 phase。
 *
 * confirmation 变体:Codex app-server 的命令执行/文件变更审批
 * (interrupt.reason === "confirmation")。与 AskUserQuestion 的 input_required
 * 不同,审批的 toolCallId 是 app-server raw itemId(如 exec-xxx),
 * 与 TOOL_CALL_START 的 `${runId}-${itemId}` 格式不同,part 可能为 null
 * (窗口期)或通过后缀匹配找到。
 */
export type PendingQuestion =
  | { phase: "streaming"; part: ToolCallPart }
  | { phase: "open"; part: ToolCallPart; interrupt: AgUiInterrupt }
  | { phase: "open"; part: ToolCallPart | null; interrupt: AgUiInterrupt; confirmation: true }
  | { phase: "open"; part: ToolCallPart | null; interrupt: AgUiInterrupt; acpPermission: true };

/**
 * 扫描消息列表得到待答问题描述;panel / 答题 UI / 提交全部只吃这一份,
 * 不允许再各自扫 part 形状或 metadata(两套判据会在窗口期互相矛盾)。
 * 后端串行化保证同一时刻至多 1 个待答问题。
 */
export function getPendingQuestion(
  messages: readonly ThreadMessageLike[],
): PendingQuestion | null {
  const message = lastAssistantMessage(messages);
  if (
    message?.status?.type === "requires-action" &&
    message.status.reason === "interrupt"
  ) {
    const interrupt = readAgUiCustomMetadata(message.metadata)?.interrupts?.[0];
    if (interrupt) {
      // Confirmation interrupt (command/file approval from Codex app-server)
      if (interrupt.reason === "confirmation") {
        const parts = Array.isArray(message.parts) ? message.parts : [];
        const part = findConfirmationToolPart(parts, interrupt.toolCallId);
        return { phase: "open", part, interrupt, confirmation: true };
      }

      // ACP permission interrupt (generic ACP agent, e.g. OpenCode) — 数据全在
      // metadata.options,无 tool part。
      if (interrupt.reason === "approval_required") {
        return { phase: "open", part: null, interrupt, acpPermission: true };
      }

      // Regular AskUserQuestion / AskUserPermission interrupt
      const parts = Array.isArray(message.parts) ? message.parts : [];
      const candidates = parts.filter(isPendingQuestionToolPart);
      const part =
        candidates.find((p) => p.toolCallId === interrupt.toolCallId) ??
        candidates[candidates.length - 1];
      if (part) return { phase: "open", part, interrupt };
      // interrupt 挂着但 part 已回填/缺失:落到下面的扫描,自然得 null。
    }
  }
  const part = findPendingQuestionPart(messages);
  return part ? { phase: "streaming", part } : null;
}

function lastAssistantMessage(
  messages: readonly ThreadMessageLike[],
): ThreadMessageLike | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant") return messages[i];
  }
  return undefined;
}

function isPendingQuestionToolPart(part: unknown): part is ToolCallPart {
  const p = part as ToolCallPart | undefined;
  return (
    !!p &&
    p.type === "tool-call" &&
    (p.toolName === "AskUserQuestion" || p.toolName === "AskUserPermission") &&
    p.result === undefined
  );
}

/** 扫描待回答的问答 part(内部:getPendingQuestion 的窗口期分支)。 */
function findPendingQuestionPart(
  messages: readonly { role: string; parts?: unknown }[],
): ToolCallPart | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || msg.role !== "assistant") continue;
    const parts = msg.parts;
    if (!Array.isArray(parts)) continue;
    for (let j = parts.length - 1; j >= 0; j--) {
      const part = parts[j] as ToolCallPart | undefined;
      if (!part || !isPendingQuestionToolPart(part)) continue;
      const status = part.status as ToolCallMessagePartStatus | undefined;
      if (isAwaitingAnswerStatus(status)) {
        return part;
      }
    }
  }
  return null;
}

/**
 * 匹配 confirmation interrupt 对应的 tool-call part。
 *
 * interrupt.toolCallId 是 app-server raw itemId(如 `exec-xxx`),
 * 而 part.toolCallId 是 `${runId}-${itemId}`(如 `019f...-exec-xxx`)。
 * 通过后缀匹配找到对应的 part;找不到时返回 null(part 可能尚未到达)。
 */
function findConfirmationToolPart(
  parts: readonly unknown[],
  interruptToolCallId?: string,
): ToolCallPart | null {
  if (!interruptToolCallId) return null;
  const suffix = `-${interruptToolCallId}`;
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i] as ToolCallPart | undefined;
    if (!p || p.type !== "tool-call" || p.result !== undefined) continue;
    if (p.toolCallId?.endsWith(suffix)) return p;
  }
  return null;
}
