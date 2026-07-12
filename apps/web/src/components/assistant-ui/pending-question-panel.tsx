"use client";

import { useEffect, useRef } from "react";
import { useAuiState } from "@assistant-ui/react";
import { ShieldCheckIcon, MessageCircleQuestionIcon } from "lucide-react";
import { AskUserQuestionUI } from "@/components/assistant-ui/tools/ask-user-question";
import {
  getPendingQuestion,
  type ToolCallPart,
} from "@/components/assistant-ui/thread-utils";

// ── Panel ────────────────────────────────────────────────────────────────────

export function PendingQuestionPanel() {
  const pending = useAuiState((s) => getPendingQuestion(s.thread.messages));

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
