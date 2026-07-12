"use client";

import { useEffect, useMemo, useRef } from "react";
import { useAuiState } from "@assistant-ui/react";
import { ShieldCheckIcon, MessageCircleQuestionIcon } from "lucide-react";
import {
  AskUserQuestionUI,
  ConfirmationApprovalUI,
  AcpPermissionUI,
} from "@/components/assistant-ui/tools/ask-user-question";
import {
  getPendingQuestion,
  type ToolCallPart,
} from "@/components/assistant-ui/thread-utils";

// ── Panel ────────────────────────────────────────────────────────────────────

export function PendingQuestionPanel() {
  // 选原始 messages(引用稳定,store 状态不变时不会触发重渲染),
  // 再用 useMemo 派生 pending——避免 selector 内返回新对象导致无限循环。
  const messages = useAuiState((s) => s.thread.messages);
  const pending = useMemo(() => getPendingQuestion(messages), [messages]);

  // 卡片出现时自动滚到底部，让用户立刻看到。
  const hasPendingRef = useRef(false);
  useEffect(() => {
    const hasNow = pending !== null;
    if (hasNow && !hasPendingRef.current) {
      requestAnimationFrame(() => {
        const el = document.querySelector('[data-slot="aui_thread-viewport"]');
        if (el) el.scrollTop = el.scrollHeight;
      });
    }
    hasPendingRef.current = hasNow;
  }, [pending]);

  if (!pending) return null;

  // Confirmation interrupt (Codex command/file approval) — 不依赖 part,
  // 数据全部来自 pending.interrupt.metadata。
  if ("confirmation" in pending && pending.confirmation) {
    return <ConfirmationApprovalUI pending={pending} />;
  }

  // ACP permission interrupt (generic ACP agent, e.g. OpenCode).
  if ("acpPermission" in pending && pending.acpPermission) {
    return <AcpPermissionUI pending={pending} />;
  }

  // part 可能为 null (confirmation 已在上面处理,这里 part 一定存在)
  if (!pending.part) return null;

  return <AskUserQuestionUI part={pending.part} pending={pending} />;
}

// ── 正文里的折叠简化态 ──────────────────────────────────────────────────────
// running 的 AskUserQuestion part 在正文里显示一个轻量"等待中"标记，
// 不渲染交互按钮（交互交给 composer 上方的 panel）。
// 注意：这里是"等用户回答"，不是"系统在执行"，所以用静态图标而非 spinner。

export function AskUserQuestionCompact({ part }: { part: ToolCallPart }) {
  const isPermission = part.toolName === "AskUserPermission";
  const title = isPermission ? "等待权限确认" : "等待回答";
  const Icon = isPermission ? ShieldCheckIcon : MessageCircleQuestionIcon;

  return (
    <div className="my-1 flex items-center gap-1.5 rounded-md px-1 py-0.5 text-xs text-muted-foreground">
      <Icon className="size-3 shrink-0 text-amber-500" />
      <span className="truncate">{title}</span>
    </div>
  );
}
