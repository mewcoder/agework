import { Observable } from "rxjs";
import {
  EventType,
  type BaseEvent,
  type RunAgentInput,
} from "@ag-ui/client";
import { type AgentType } from "@/stores/selection-store";
import { useSelectionStore } from "@/stores/selection-store";
import { useRuntimeUiStore } from "@/stores/runtime-ui-store";
import { isPlainObject } from "lodash-es";

type SelectionStoreSnapshot = ReturnType<typeof useSelectionStore.getState>;

function permissionForwardedProps(agentType: AgentType, state: SelectionStoreSnapshot) {
  if (agentType === "claude") {
    return { permissionMode: state.claudePermissionMode };
  }

  if (state.codexPermissionMode === "full-access") {
    return {
      sandboxMode: "danger-full-access",
      approvalPolicy: "never",
      approvalsReviewer: "user",
      networkAccessEnabled: true,
    };
  }
  if (state.codexPermissionMode === "default") {
    return {
      sandboxMode: "workspace-write",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      networkAccessEnabled: false,
    };
  }
  return {
    sandboxMode: "workspace-write",
    approvalPolicy: "on-request",
    approvalsReviewer: "auto_review",
    networkAccessEnabled: false,
  };
}

export function extractRunMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .filter(
      (part): part is { text: string } =>
        isPlainObject(part) && typeof part.text === "string",
    )
    .map((part) => part.text)
    .join(" ");
}

export function createFallbackTitle(input: RunAgentInput) {
  const messages = Array.isArray(input.messages) ? input.messages : [];
  const lastUserMessage = messages.findLast(
    (message) => isPlainObject(message) && message.role === "user",
  );
  if (!lastUserMessage || !isPlainObject(lastUserMessage)) return undefined;

  const text = extractRunMessageText(lastUserMessage.content)
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return undefined;

  const title = text
    .slice(0, 40)
    .replace(
      /[，。、；！？,.;!?…—\-~·"'"'「」『』（）()【】[\]《》<>\s]+$/u,
      "",
    );
  return title || undefined;
}

export function withRunSettings(
  params: RunAgentInput,
  conversationId: string,
  agentType: AgentType,
  state: SelectionStoreSnapshot,
): RunAgentInput {
  const modelProviderId = state.selectedModelProviderIds[agentType];
  const model = modelProviderId
    ? state.selectedModelByProviderIds[modelProviderId]
    : undefined;
  const interruptReason = useRuntimeUiStore
    .getState()
    .consumePendingRunInterruptReason(conversationId);

  return {
    ...params,
    // AG-UI 边界字段：threadId 即 AgeWork 的 conversationId
    threadId: conversationId,
    ...(interruptReason ? { interruptReason } : {}),
    forwardedProps: {
      ...(params.forwardedProps ?? {}),
      agentType,
      ...(modelProviderId ? { modelProviderId } : {}),
      ...(model ? { model } : {}),
      ...(agentType === "codex"
        ? { modelReasoningEffort: state.modelReasoningEffort }
        : {}),
      ...(agentType === "claude"
        ? { claudeThinkingMode: state.claudeThinkingMode }
        : {}),
      ...permissionForwardedProps(agentType, state),
    },
  };
}

// ── RUN_ERROR 可见化 ─────────────────────────────────────────────────────────
function agentLabel(input: RunAgentInput) {
  const agentType = input.forwardedProps?.agentType;
  if (agentType === "codex") return "Codex";
  if (agentType === "claude") return "Claude";
  return "Agent";
}

function runErrorText(input: RunAgentInput, event: BaseEvent) {
  const message =
    "message" in event &&
    typeof event.message === "string" &&
    event.message.trim()
      ? event.message
      : "运行失败，但没有返回错误详情。";
  const code =
    "code" in event && typeof event.code === "string" && event.code.trim()
      ? `\n\n错误代码：\`${event.code}\``
      : "";

  return `**${agentLabel(input)} 运行失败**\n\n${message}${code}`;
}

function visibleRunErrorEvents(
  input: RunAgentInput,
  event: BaseEvent,
): BaseEvent[] {
  const runId = typeof input.runId === "string" ? input.runId : "run";
  const messageId = `${runId}-error`;

  return [
    { type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant" },
    {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId,
      delta: runErrorText(input, event),
    },
    { type: EventType.TEXT_MESSAGE_END, messageId },
    event,
  ];
}

// gap loading 状态 + RUN_ERROR 转可见消息
export function interceptRunEvents(
  input: RunAgentInput,
  events: ReturnType<import("@ag-ui/client").HttpAgent["run"]>,
): ReturnType<import("@ag-ui/client").HttpAgent["run"]> {
  return new Observable<BaseEvent>((subscriber) => {
    let toolGapTimer: ReturnType<typeof setTimeout> | null = null;

    const setGap = (inGap: boolean) => {
      useRuntimeUiStore.setState({ isAssistantInGap: inGap });
    };

    const clearToolTimer = () => {
      if (toolGapTimer) {
        clearTimeout(toolGapTimer);
        toolGapTimer = null;
      }
    };

    const sub = (events as unknown as Observable<BaseEvent>).subscribe({
      next(event) {
        if (event.type === EventType.RUN_STARTED) {
          setGap(true);
          // 新 run 开始，清除该 conversation 的 cancelled 标记（input.threadId 即 conversationId）
          const conversationId = input.threadId;
          if (conversationId) {
            const runtimeUi = useRuntimeUiStore.getState();
            runtimeUi.clearConversationCancelled(conversationId);
          }
        }

        if (
          event.type === EventType.REASONING_START ||
          event.type === EventType.TEXT_MESSAGE_START
        ) {
          clearToolTimer();
          setGap(false);
        }

        if (event.type === EventType.TOOL_CALL_START) {
          clearToolTimer();
          setGap(false);
        }

        if (event.type === EventType.REASONING_END) {
          setGap(true);
        }

        // 工具结束：延迟显示 loading，工具间快速切换时不触发
        if (event.type === EventType.TOOL_CALL_END) {
          toolGapTimer = setTimeout(() => {
            toolGapTimer = null;
            setGap(true);
          }, 100);
        }

        if (
          event.type === EventType.RUN_FINISHED ||
          event.type === EventType.RUN_ERROR
        ) {
          clearToolTimer();
          setGap(false);
        }

        const nextEvents =
          event.type === EventType.RUN_ERROR
            ? visibleRunErrorEvents(input, event)
            : [event];

        for (const nextEvent of nextEvents) subscriber.next(nextEvent);
      },
      error(error) {
        clearToolTimer();
        setGap(false);
        subscriber.error(error);
      },
      complete() {
        clearToolTimer();
        setGap(false);
        subscriber.complete();
      },
    });

    return () => {
      clearToolTimer();
      setGap(false);
      sub.unsubscribe();
    };
  }) as unknown as ReturnType<import("@ag-ui/client").HttpAgent["run"]>;
}
