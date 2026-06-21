"use client";

import { useState, useMemo, useRef, useId } from "react";
import { CheckIcon, ChevronLeftIcon, ChevronRightIcon, XIcon } from "lucide-react";
import type { ToolCallMessagePartStatus } from "@assistant-ui/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToolFallback } from "@/components/assistant-ui/tool-fallback";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { conversationsApi } from "@/api/conversations";
import { useSelectionStore } from "@/stores/selection-store";
import { useRuntimeUiStore } from "@/stores/runtime-ui-store";

// ── Types ─────────────────────────────────────────────────────────────────────

export type AskUserQuestionOption = {
  label: string;
  description: string;
  preview?: string;
};

export type AskUserQuestionItem = {
  question: string;
  header: string;
  options: AskUserQuestionOption[];
  multiSelect?: boolean;
};

export type AskUserQuestionInput = {
  questions: AskUserQuestionItem[];
  answers?: AskUserQuestionAnswers;
};

export type AskUserQuestionAnswers = Record<string, string | string[]>;

type ToolPart = {
  toolCallId?: string;
  toolName?: string;
  argsText?: string;
  result?: unknown;
  status?: ToolCallMessagePartStatus;
};

// ── Permission prompt ─────────────────────────────────────────────────────────
// 后端拦截工具权限时合成的工具调用名是 "AskUserPermission"（跟模型自己真实调用的
// "AskUserQuestion" 是两个不同的 toolName），靠 part.toolName 直接区分即可，
// 不用再嗅探 header/options 文案。
// "始终允许"：后端只在 canUseTool 传回了 localSettings suggestion 时才会把这个
// option 塞进 argsText，前端据此条件渲染第三按钮；点了之后后端把规则作为
// updatedPermissions 返回给 SDK，SDK 写入 workspace 的 .claude/settings.local.json。
export const PERMISSION_ALLOW_LABEL = "允许";
export const PERMISSION_DENY_LABEL = "拒绝";
export const PERMISSION_ALWAYS_ALLOW_LABEL = "始终允许";

type QuestionPanelProps = {
  item: AskUserQuestionItem;
  value: string | string[] | undefined;
  onChange: (value: string | string[]) => void;
  disabled: boolean;
};

const OTHER_SENTINEL = "__other__";

// ── Single-select panel (RadioGroup) ─────────────────────────────────────────

function SingleSelectPanel({ item, value, onChange, disabled }: QuestionPanelProps) {
  const baseId = useId();
  const otherInputRef = useRef<HTMLInputElement>(null);

  const isKnownOption = item.options.some((o) => o.label === value);
  const radioValue = isKnownOption ? (value as string) : value ? OTHER_SENTINEL : "";
  const [otherText, setOtherText] = useState(() =>
    isKnownOption ? "" : ((value as string | undefined) ?? ""),
  );

  const handleRadioChange = (val: string) => {
    if (val === OTHER_SENTINEL) {
      onChange(otherText || OTHER_SENTINEL);
      setTimeout(() => otherInputRef.current?.focus(), 0);
    } else {
      onChange(val);
    }
  };

  const handleOtherTextChange = (text: string) => {
    setOtherText(text);
    onChange(text || OTHER_SENTINEL);
  };

  return (
    <FieldSet>
      <FieldLegend variant="label">{item.question}</FieldLegend>
      <RadioGroup value={radioValue} onValueChange={handleRadioChange} disabled={disabled}>
        {item.options.map((opt, i) => (
          <Field key={opt.label} orientation="horizontal">
            <RadioGroupItem value={opt.label} id={`${baseId}-${i}`} />
            <FieldContent>
              <FieldLabel htmlFor={`${baseId}-${i}`} className="font-normal">
                {opt.label}
              </FieldLabel>
              {opt.description && (
                <FieldDescription>{opt.description}</FieldDescription>
              )}
            </FieldContent>
          </Field>
        ))}
        <Field orientation="horizontal">
          <RadioGroupItem value={OTHER_SENTINEL} id={`${baseId}-other`} />
          <FieldLabel htmlFor={`${baseId}-other`} className="font-normal">
            其他
          </FieldLabel>
        </Field>
      </RadioGroup>
      {radioValue === OTHER_SENTINEL && (
        <Input
          ref={otherInputRef}
          placeholder="请输入…"
          value={otherText}
          disabled={disabled}
          onChange={(e) => handleOtherTextChange(e.target.value)}
          className="h-8 text-[12px]"
        />
      )}
    </FieldSet>
  );
}

// ── Multi-select panel (Checkbox) ─────────────────────────────────────────────

function MultiSelectPanel({ item, value, onChange, disabled }: QuestionPanelProps) {
  const baseId = useId();
  const otherInputRef = useRef<HTMLInputElement>(null);

  const selected = Array.isArray(value) ? value : [];
  const knownLabels = new Set(item.options.map((o) => o.label));
  const isOtherChecked = selected.some((v) => !knownLabels.has(v));
  const [otherText, setOtherText] = useState(() => selected.find((v) => !knownLabels.has(v)) ?? "");

  const toggleOption = (label: string, checked: boolean) => {
    const known = selected.filter((v) => knownLabels.has(v));
    const others = selected.filter((v) => !knownLabels.has(v));
    const next = checked ? [...known, label] : known.filter((v) => v !== label);
    onChange([...next, ...others]);
  };

  const toggleOther = (checked: boolean) => {
    const known = selected.filter((v) => knownLabels.has(v));
    if (checked) {
      setTimeout(() => otherInputRef.current?.focus(), 0);
      onChange(otherText ? [...known, otherText] : known);
    } else {
      setOtherText("");
      onChange(known);
    }
  };

  const handleOtherTextChange = (text: string) => {
    setOtherText(text);
    const known = selected.filter((v) => knownLabels.has(v));
    onChange(text ? [...known, text] : known);
  };

  return (
    <FieldSet>
      <FieldLegend variant="label">{item.question}</FieldLegend>
      <FieldDescription>可多选</FieldDescription>
      <FieldGroup className="gap-3">
        {item.options.map((opt, i) => (
          <Field key={opt.label} orientation="horizontal">
            <Checkbox
              id={`${baseId}-${i}`}
              checked={selected.includes(opt.label)}
              onCheckedChange={(c) => toggleOption(opt.label, c === true)}
              disabled={disabled}
            />
            <FieldContent>
              <FieldLabel htmlFor={`${baseId}-${i}`} className="font-normal">
                {opt.label}
              </FieldLabel>
              {opt.description && (
                <FieldDescription>{opt.description}</FieldDescription>
              )}
            </FieldContent>
          </Field>
        ))}
        <Field orientation="horizontal">
          <Checkbox
            id={`${baseId}-other`}
            checked={isOtherChecked}
            onCheckedChange={(c) => toggleOther(c === true)}
            disabled={disabled}
          />
          <FieldLabel htmlFor={`${baseId}-other`} className="font-normal">
            其他
          </FieldLabel>
        </Field>
      </FieldGroup>
      {isOtherChecked && (
        <Input
          ref={otherInputRef}
          placeholder="请输入…"
          value={otherText}
          disabled={disabled}
          onChange={(e) => handleOtherTextChange(e.target.value)}
          className="h-8 text-[12px]"
        />
      )}
    </FieldSet>
  );
}

// ── Question panel dispatcher ─────────────────────────────────────────────────

function QuestionPanel(props: QuestionPanelProps) {
  return props.item.multiSelect ? <MultiSelectPanel {...props} /> : <SingleSelectPanel {...props} />;
}

// ── Submitted / read-only view ────────────────────────────────────────────────

function SubmittedView({
  questions,
  answers,
}: {
  questions: AskUserQuestionItem[];
  answers: AskUserQuestionAnswers;
}) {
  return (
  <dl className="flex flex-col gap-1.5 text-[13px] leading-5">
    {questions.map((q) => {
      const answer = answers[q.question];
      const display = Array.isArray(answer) ? answer.join("，") : (answer ?? "—");
      return (
        <div key={q.question} className="flex items-start gap-2">
          <dt className="shrink-0 font-medium text-muted-foreground">{q.header}：</dt>
          <dd className="min-w-0 flex-1 text-foreground/80">{display}</dd>
        </div>
      );
    })}
  </dl>
  );
}

// ── Permission prompt (Allow / Deny) ─────────────────────────────────────────
// 后端拦截工具权限后注入的 AskUserQuestion，走精简单行样式：
// 一行展示标题 + 原因 + 允许/拒绝两个小按钮，不用 amber 主题、不用独立卡片边框。

function PermissionPromptUI({
  item,
  conversationId,
  statusType,
}: {
  item: AskUserQuestionItem;
  conversationId: string | null;
  statusType: ToolCallMessagePartStatus["type"];
}) {
  const allowOption = item.options.find((o) => o.label === PERMISSION_ALLOW_LABEL) ?? item.options[0];
  const denyOption = item.options.find((o) => o.label === PERMISSION_DENY_LABEL) ?? item.options[item.options.length - 1];
  const alwaysAllowOption = item.options.find((o) => o.label === PERMISSION_ALWAYS_ALLOW_LABEL);
  const description = allowOption.description;

  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState<string | null>(null);

  const isInteractive = statusType === "running" && !submitted;
  // composer 上方的 panel 渲染时，提交后直接返回 null——让 panel 消失，
  // 后端会继续推流（TOOL_CALL_END / 后续文本等），正文里的 AskUserQuestion
  // 会从 running 变成 complete，panel 不应再占位。
  const inPanel = statusType === "running";
  if (!isInteractive && !submitted) return null;
  if (submitted && inPanel) return null;

  const handleSubmit = async (answer: string) => {
    if (!conversationId || submitting) return;
    setSubmitting(true);
    try {
      await conversationsApi.submitQuestionAnswer(conversationId, {
        [item.question]: answer,
      });
      setSubmitted(answer);
      // 标记此 conversation 已回答 pending question，让 Thread 组件检测到后
      // 重新 load + resume，接上 worker 继续执行产生的 SSE 流。
      if (conversationId) {
        useRuntimeUiStore.getState().markPendingQuestionReplied(conversationId);
      }
    } catch (err) {
      console.error("[PermissionPrompt] submit failed:", err);
    } finally {
      setSubmitting(false);
    }
  };

  if (submitted) {
    const isAllowed =
      submitted === PERMISSION_ALLOW_LABEL ||
      submitted === PERMISSION_ALWAYS_ALLOW_LABEL;
    return (
      <div className="my-1 overflow-hidden rounded-lg border border-border/60 bg-background">
        <div className="flex items-center gap-1.5 px-3 py-2 text-[12px] text-muted-foreground">
          {isAllowed ? (
            <CheckIcon className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
          ) : (
            <XIcon className="size-3.5 shrink-0 text-destructive" />
          )}
          <span className="truncate">{submitted}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="my-1 overflow-hidden rounded-lg border border-border/60 bg-background">
      <div className="flex items-center gap-2 px-3 py-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] leading-5 text-foreground">{item.question}</p>
          {description && (
            <p className="truncate text-[12px] leading-5 text-muted-foreground">{description}</p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {alwaysAllowOption && (
            <Button
              size="sm"
              onClick={() => void handleSubmit(PERMISSION_ALWAYS_ALLOW_LABEL)}
              disabled={submitting}
              className="h-7 px-3 text-xs"
            >
              {alwaysAllowOption.label}
            </Button>
          )}
          <Button
            size="sm"
            onClick={() => void handleSubmit(PERMISSION_ALLOW_LABEL)}
            disabled={submitting}
            className="h-7 px-3 text-xs"
          >
            {submitting ? (
              <span className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
            ) : (
              <CheckIcon className="size-3.5" />
            )}
            {allowOption.label}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void handleSubmit(PERMISSION_DENY_LABEL)}
            disabled={submitting}
            className="h-7 px-3 text-xs"
          >
            {denyOption.label}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── Main export ───────────────────────────────────────────────────────────────

export function AskUserQuestionUI({ part }: { part: ToolPart }) {
  const conversationId = useSelectionStore((s) => s.selectedConversationId);
  const statusType = part.status?.type ?? "complete";

  const input = useMemo((): AskUserQuestionInput => {
    try {
      const parsed = JSON.parse(part.argsText || "{}") as Partial<AskUserQuestionInput>;
      return {
        questions: parsed.questions ?? [],
        answers: parsed.answers,
      };
    } catch {
      return { questions: [] };
    }
  }, [part.argsText]);
  const questions = input.questions;

  const [answers, setAnswers] = useState<AskUserQuestionAnswers>({});
  const [submitting, setSubmitting] = useState(false);
  const [submittedAnswers, setSubmittedAnswers] = useState<AskUserQuestionAnswers | null>(null);
  const [currentIndex, setCurrentIndex] = useState(0);

  const isInteractive = statusType === "running" && !submittedAnswers;

  const isAnswered = (q: AskUserQuestionItem) => {
    const a = answers[q.question];
    if (Array.isArray(a)) return a.length > 0;
    return Boolean(a) && a !== OTHER_SENTINEL;
  };

  const allAnswered = questions.length > 0 && questions.every(isAnswered);
  const answeredCount = questions.filter(isAnswered).length;

  const handleSubmit = async () => {
    if (!conversationId || !allAnswered) return;
    setSubmitting(true);
    try {
      await conversationsApi.submitQuestionAnswer(conversationId, answers);
      setSubmittedAnswers(answers);
      if (conversationId) {
        useRuntimeUiStore.getState().markPendingQuestionReplied(conversationId);
      }
    } catch (err) {
      console.error("[AskUserQuestion] submit failed:", err);
    } finally {
      setSubmitting(false);
    }
  };

  const visibleSubmittedAnswers = submittedAnswers ?? input.answers ?? null;

  // composer 上方 panel 渲染时（running 态），提交后直接返回 null——
  // 让 panel 消失，后端会继续推流，正文里的 AskUserQuestion 从 running
  // 变成 complete，panel 不应再占位。历史消息（非 running）不归 panel 管。
  const inPanel = statusType === "running";
  if (submittedAnswers && inPanel) return null;

  // 历史/已结束态（非 running）且没有任何可见答案时，fallback 到 ToolFallback
  // 折叠卡片。否则历史消息里这个工具调用会完全消失（后端权限审批的 argsText
  // 只存 {questions} 不存 answers，普通问答也可能没有 answers）。
  const hasVisibleAnswers = Boolean(visibleSubmittedAnswers);
  if (!isInteractive && !hasVisibleAnswers) {
    return (
      <ToolFallback.Root data-status={statusType} className="py-0">
        <ToolFallback.Trigger toolName={part.toolName ?? "AskUserQuestion"} status={part.status} />
        <ToolFallback.Content>
          <ToolFallback.Args argsText={part.argsText} />
        </ToolFallback.Content>
      </ToolFallback.Root>
    );
  }

  // 权限审批场景（后端 buildToolPermissionQuestion 注入，toolName 固定是
  // "AskUserPermission"）走专门的 Allow/Deny UI，不套用普通问答的 RadioGroup +
  // 其他 + 确认。
  if (part.toolName === "AskUserPermission") {
    return (
      <PermissionPromptUI
        item={input.questions[0]}
        conversationId={conversationId ?? null}
        statusType={statusType}
      />
    );
  }

  if (visibleSubmittedAnswers) {
    const status =
      submittedAnswers && part.status?.type === "running"
        ? ({ type: "complete" } satisfies ToolCallMessagePartStatus)
        : part.status;

    return (
      <ToolFallback.Root data-status={status?.type ?? "complete"} className="py-0">
        <ToolFallback.Trigger toolName={part.toolName ?? "AskUserQuestion"} status={status} />
        <ToolFallback.Content>
          <SubmittedView questions={questions} answers={visibleSubmittedAnswers} />
        </ToolFallback.Content>
      </ToolFallback.Root>
    );
  }

  // running 但 questions 还没到（TOOL_CALL_START 已到、TOOL_CALL_ARGS 未到，
  // argsText 为空解析不出 questions）。显示轻量占位卡片，避免正文已显示
  // "等待回答"而 composer 上方还空着的割裂感。
  if (isInteractive && questions.length === 0) {
    return (
      <div className="my-1 overflow-hidden rounded-lg border border-border/60 bg-background">
        <div className="flex items-center gap-1.5 px-3 py-2 text-[12px] text-muted-foreground">
          <span className="size-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
          <span>加载中…</span>
        </div>
      </div>
    );
  }

  if (!isInteractive || questions.length === 0) return null;

  if (questions.length === 1) {
    const q = questions[0];
    return (
      <div className="my-1 overflow-hidden rounded-lg border border-border/60 bg-background">
        <div className="p-4">
          <QuestionPanel
            item={q}
            value={answers[q.question]}
            onChange={(v) => setAnswers((prev) => ({ ...prev, [q.question]: v }))}
            disabled={submitting}
          />
        </div>
        <div className="flex items-center justify-end border-t border-border/60 bg-muted/20 px-4 py-2.5">
          <Button
            size="sm"
            onClick={() => void handleSubmit()}
            disabled={!allAnswered || submitting}
            className="h-7 px-4 text-xs"
          >
            {submitting ? "提交中…" : "确认"}
          </Button>
        </div>
      </div>
    );
  }

  const activeValue = questions[currentIndex]?.question ?? questions[0].question;

  const footer = (
    <div className="flex items-center justify-between border-t border-border/60 bg-muted/20 px-4 py-2.5">
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          disabled={currentIndex === 0}
          onClick={() => setCurrentIndex((i) => Math.max(0, i - 1))}
        >
          <ChevronLeftIcon className="size-4" />
        </Button>
        <span className="min-w-[4rem] text-center text-[11px] text-muted-foreground">
          {currentIndex + 1} / {questions.length}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          disabled={currentIndex === questions.length - 1}
          onClick={() => setCurrentIndex((i) => Math.min(questions.length - 1, i + 1))}
        >
          <ChevronRightIcon className="size-4" />
        </Button>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-[11px] text-muted-foreground">
          {answeredCount} / {questions.length} 已回答
        </span>
        <Button
          size="sm"
          onClick={() => void handleSubmit()}
          disabled={!allAnswered || submitting}
          className="h-7 px-4 text-xs"
        >
          {submitting ? "提交中…" : "确认"}
        </Button>
      </div>
    </div>
  );

  return (
    <div className="my-1 overflow-hidden rounded-lg border border-border/60 bg-background">
      <Tabs value={activeValue} onValueChange={(v) => {
        const idx = questions.findIndex((q) => q.question === v);
        if (idx >= 0) setCurrentIndex(idx);
      }}>
        <div className="border-b border-border/60 px-3 pt-1">
          <TabsList variant="line" className="h-9">
            {questions.map((q) => (
              <TabsTrigger key={q.question} value={q.question} className="gap-1.5 text-[12px]">
                {q.header}
                {isAnswered(q) && (
                  <Badge variant="default" className="size-3.5 rounded-full p-0 flex items-center justify-center">
                    <CheckIcon className="size-2.5 stroke-[3]" />
                  </Badge>
                )}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>

        {questions.map((q) => (
          <TabsContent key={q.question} value={q.question} className="mt-0 p-4">
            <QuestionPanel
              item={q}
              value={answers[q.question]}
              onChange={(v) => setAnswers((prev) => ({ ...prev, [q.question]: v }))}
              disabled={submitting}
            />
          </TabsContent>
        ))}
      </Tabs>
      {footer}
    </div>
  );
}
