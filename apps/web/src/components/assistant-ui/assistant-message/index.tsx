import { memo, useCallback, useEffect, useMemo, useRef, type FC } from "react";
import { MessagePrimitive, useAuiState } from "@assistant-ui/react";
import { MarkdownText } from "@/components/assistant-ui/markdown-text";
import { Reasoning, ReasoningText } from "@/components/assistant-ui/reasoning";
import { ToolFallback } from "@/components/assistant-ui/tool-fallback";
import { AskUserQuestionUI } from "@/components/assistant-ui/tools/ask-user-question";
import { AskUserQuestionCompact } from "@/components/assistant-ui/pending-question-panel";
import { BranchPicker } from "@/components/assistant-ui/branch-picker";
import { getAssistantStage, type AssistantStage } from "@/components/assistant-ui/assistant-loading";
import { AgentIcon } from "@/components/icons/agent";
import { useConversations } from "@/hooks/use-conversation";
import { agentLabel } from "@/utils/model-provider";
import { useSelectionStore } from "@/stores/selection-store";
import { useRunSessionStore } from "@/stores/run-session-store";
import { cn } from "@/lib/utils";
import {
  type GroupableMessagePart,
  type ToolCallPart,
  getProcessTitleTextParts,
  isToolCallPart,
} from "@/components/assistant-ui/thread-utils";
import { ToolGroup, ProcessBlock } from "./process-block";
import { MessageError } from "./message-error";
import { AssistantActionBar, RunDuration } from "./action-bar";

const ToolFallbackFC = ToolFallback as unknown as FC<ToolCallPart>;

const STAGE_LABEL: Record<AssistantStage, string> = {
  thinking: "思考中",
  executing: "执行中",
  replying: "回复中",
};

export const AssistantMessage = memo(function AssistantMessage() {
  // reserves space for action bar and compensates with `-mb` for consistent msg spacing
  // keeps hovered action bar from shifting layout (autohide doesn't support absolute positioning well)
  // for pt-[n] use -mb-[n + 6] & min-h-[n + 6] to preserve compensation
  const ACTION_BAR_PT = "pt-1.5";
  const ACTION_BAR_HEIGHT = `-mb-7.5 min-h-7.5 ${ACTION_BAR_PT}`;
  const messageStatus = useAuiState((s) =>
    s.message.role === "assistant"
      ? (s.message.status as { type?: string; reason?: string } | undefined)
      : undefined,
  );
  const isRunning = messageStatus?.type === "running";
  // 运行期间按当前 part 阶段切换底部文案（思考中 / 执行中 / 回复中）。
  // resume 流式恢复时 status 同样归一化成 running，阶段判定一致。
  const stage = useAuiState((s) => getAssistantStage(s.message));

  // 本组件是否亲眼见过这条消息处于 running —— 见过的话，无论它如何收尾
  // （正常完成 / 用户主动停止），当前内容都已经是最终结果，是"活着"看到的，
  // 不存在"快照可能滞后"的问题。
  const everRanRef = useRef(false);
  useEffect(() => {
    if (isRunning) everRanRef.current = true;
  }, [isRunning]);

  // 刷新页面后续接进行中的 run 时，后端中间快照的 status 已在
  // thread-history-adapter.resume 里归一化成 { type:"running" }，所以
  // isRunning 在 resume 期间同样为 true，UI 与正常流式运行一致
  // （thinking、展开处理过程、工具显示运行中）。无需额外识别快照状态。
  const selectedConversationId = useSelectionStore((s) => s.selectedConversationId);
  const selectedAgentType = useSelectionStore((s) => s.selectedAgentType);
  const { data: conversationsData } = useConversations(undefined, "updatedAt");
  const conversation = conversationsData?.conversations.find(
    (c) => c.conversationId === selectedConversationId,
  );
  const agentType = conversation?.agentType ?? selectedAgentType;

  // 三方库在用户取消后会用合成 RUN_FINISHED 覆盖 status 为 complete，
  // 所以除了看 messageStatus，还要看我们自己记录的"用户点过停止"标记。
  const conversationCancelled = useRunSessionStore((s) =>
    selectedConversationId ? s.cancelledConversations.has(selectedConversationId) : false,
  );
  const messageId = useAuiState((s) => s.message.id);
  const isUserSteered = useRunSessionStore((s) =>
    selectedConversationId && messageId
      ? (s.userSteeredMessageIdsByConversation[selectedConversationId]?.has(messageId) ?? false)
      : false,
  );
  const isMessageUserSteered =
    messageStatus?.type === "incomplete" && messageStatus?.reason === "user_steered";
  const isCancelled =
    !isUserSteered &&
    !isMessageUserSteered &&
    ((messageStatus?.type === "incomplete" && messageStatus?.reason === "cancelled") ||
      (everRanRef.current && conversationCancelled));

  const showAsActive = isRunning;

  // parentId 存在 = 工具调用在对应文本 MESSAGE_END 之前触发（文本包裹了工具）
  // 只有带 parentId 的工具才会把之前暂存的 text 提升为工具组标题。
  const messageParts = useAuiState(
    (s) => s.message.parts as readonly GroupableMessagePart[],
  );
  const processTitleTextParts = useMemo(
    () => getProcessTitleTextParts(messageParts),
    [messageParts],
  );
  const groupMessagePart = useCallback(
    (part: { type: string; parentId?: string; toolName?: string; status?: { type?: string } }) => {
      if (part.type === "reasoning") return ["group-process", "group-reasoning"] as const;
      if (part.type === "tool-call") {
        return ["group-process", "group-tool"] as const;
      }
      if (part.type === "text" && processTitleTextParts?.has(part)) {
        return ["group-process", "group-process-text"] as const;
      }
      return null;
    },
    [processTitleTextParts],
  );

  return (
    <MessagePrimitive.Root
      data-slot="aui_assistant-message-root"
      data-role="assistant"
      className="relative animate-in duration-150 fade-in slide-in-from-bottom-1"
    >
      <div
        data-slot="aui_assistant-message-header"
        className="mb-1 flex items-center gap-1.5 px-2 leading-none text-muted-foreground"
      >
        <AgentIcon agent={agentType} size={14} className="shrink-0 self-center" />
        <span className="leading-none">{agentLabel(agentType)}</span>
      </div>
      <div
        data-slot="aui_assistant-message-content"
        // [contain-intrinsic-size:auto_24px] fixes issue #4104, don't change without checking for regressions
        className="px-2 leading-relaxed wrap-break-word text-foreground [contain-intrinsic-size:auto_24px] [content-visibility:auto]"
      >
        <MessagePrimitive.GroupedParts groupBy={groupMessagePart}>
          {({ part, children }) => {
            switch (part.type) {
              case "group-process":
                return (
                  <ProcessBlock
                    active={showAsActive}
                    cancelled={isCancelled}
                    userSteered={isMessageUserSteered || isUserSteered}
                  >
                    {children}
                  </ProcessBlock>
                );
              case "group-reasoning":
                // 思考默认折叠，前缀点（跟工具统一）。运行中点脉动、完成静态。
                // my-0/py-0 覆盖 ReasoningRoot 默认 my-2，与工具卡片在 ProcessBlock 内对齐。
                return (
                  <Reasoning.Root defaultOpen={false} variant="ghost" className="my-0 py-0">
                    <Reasoning.Trigger active={showAsActive} />
                    <Reasoning.Content>
                      <ReasoningText className="aui-process-markdown max-h-none overflow-visible ps-0 pt-0 pb-0 font-normal">
                        {children}
                      </ReasoningText>
                    </Reasoning.Content>
                  </Reasoning.Root>
                );
              case "group-tool": {
                // 平铺渲染：每个工具调用独立一张卡片，各显各自的摘要。
                // 不做同名聚合——同一条 message 里的多个工具（含并行调用）
                // 意图各异，合并成 × N 会吞掉各自的描述。与 Claude Code 行为一致。
                return (
                  <ToolGroup>
                    {part.indices.map((idx, i) => {
                      const toolPart = messageParts[idx];
                      if (!toolPart || !isToolCallPart(toolPart)) return null;

                      if (
                        toolPart.toolName === "AskUserQuestion" ||
                        toolPart.toolName === "AskUserPermission"
                      ) {
                        // running 的 AskUserQuestion 交互卡片由 composer 上方的
                        // PendingQuestionPanel 接管，正文里只显示折叠简化态。
                        const status = toolPart.status as { type?: string } | undefined;
                        if (status?.type === "running") {
                          return <AskUserQuestionCompact key={i} part={toolPart} />;
                        }
                        return <AskUserQuestionUI key={i} part={toolPart} />;
                      }

                      if (toolPart.toolUI) {
                        const ToolUI = toolPart.toolUI;
                        return <ToolUI key={i} {...toolPart} />;
                      }

                      return <ToolFallbackFC key={i} {...toolPart} />;
                    })}
                  </ToolGroup>
                );
              }
              case "group-process-text":
                return (
                  <div className="aui-process-markdown max-h-none overflow-visible ps-0 pt-0 pb-0 font-normal">
                    {children}
                  </div>
                );
              case "text":
                return <MarkdownText />;
              case "reasoning":
                return <Reasoning {...part} />;
              case "tool-call": {
                if (!isToolCallPart(part)) return null;
                if (part.toolName === "AskUserQuestion" || part.toolName === "AskUserPermission") {
                  const status = part.status as { type?: string } | undefined;
                  if (status?.type === "running") {
                    return <AskUserQuestionCompact part={part} />;
                  }
                  return <AskUserQuestionUI part={part} />;
                }
                if (part.toolUI) {
                  return <part.toolUI {...part} />;
                }
                return <ToolFallbackFC {...part} />;
              }
              default:
                return null;
            }
          }}
        </MessagePrimitive.GroupedParts>
        <MessageError />
      </div>

      <div
        data-slot="aui_assistant-message-footer"
        className={cn("ms-2 flex items-center", ACTION_BAR_HEIGHT)}
      >
        <div className="flex items-center gap-1.5">
          {stage ? (
            <span className="shimmer text-[13px] text-muted-foreground motion-reduce:animate-none">
              {STAGE_LABEL[stage]}
            </span>
          ) : (
            <>
              <BranchPicker />
              <AssistantActionBar
                messageParts={messageParts}
                processTitleTextParts={processTitleTextParts}
              />
              {!showAsActive && <RunDuration />}
            </>
          )}
        </div>
      </div>
    </MessagePrimitive.Root>
  );
});
