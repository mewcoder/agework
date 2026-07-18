import { Observable } from "rxjs";
import {
  EventType,
  type BaseEvent,
  type RunAgentInput,
} from "@ag-ui/client";
import { type AgentType } from "@/stores/selection-store";
import { useSelectionStore } from "@/stores/selection-store";
import { useRunSessionStore } from "@/stores/run-session-store";
import { isPlainObject } from "lodash-es";

type SelectionStoreSnapshot = ReturnType<typeof useSelectionStore.getState>;

function permissionForwardedProps(
  agentType: AgentType,
  state: SelectionStoreSnapshot,
) {
  if (agentType === "claude") {
    return { permissionMode: state.claudePermissionMode };
  }

  if (agentType === "codex") {
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

  if (agentType === "opencode") {
    // permissionMode → opencode profile 的 permission 配置注入;
    // 计划模式经 ACP session mode 切换(acpModeId),其余档位钉回 build。
    return {
      permissionMode: state.opencodePermissionMode,
      acpModeId: state.opencodePermissionMode === "plan" ? "plan" : "build",
    };
  }

  // 其余 ACP agent(如 pi)无权限面,不注入权限相关 props。
  return {};
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
  const interruptReason = useRunSessionStore
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

// ── @ 文件提及 → context 注入 ──────────────────────────────────────

/** 边界规则：`@` 必须在行首或空白后（挡邮箱 `foo@bar.com`）。 */
const fileMentionRe = /(?:^|\s)@([^\s@]+)/g;

/**
 * 从文本中提取 `@path` 文件提及，只保留在 `knownFiles` 里存在的路径。
 * 与 `parseDirectives`（directive-text.tsx）共用同一套边界规则 + 存在性校验（SPEC §4）。
 */
export function extractFileMentions(
  text: string,
  knownFiles: Set<string>,
): string[] {
  const paths: string[] = [];
  for (const match of text.matchAll(fileMentionRe)) {
    const path = match[1]!;
    if (knownFiles.has(path) && !paths.includes(path)) {
      paths.push(path);
    }
  }
  return paths;
}

/**
 * 将 `@path` 文件提及注入 AG-UI `context` 字段（SPEC §6）。
 *
 * - 从最后一条 user 消息正文解析 `@path`，经存在性校验后填入 context。
 * - agent（Claude/Codex）通过 context → systemPrompt 看到「这些文件被用户提及了」。
 * - 注路径不注内容：agent 自己有 Read 工具，指个路就够（SPEC §6）。
 * - 两个 adapter 的 `buildStateContextAddendum` 都读 `input.context`，已确认。
 */
export function withFileMentions(
  input: RunAgentInput,
  knownFiles: Set<string> | undefined,
): RunAgentInput {
  if (!knownFiles || knownFiles.size === 0) return input;

  const messages = Array.isArray(input.messages) ? input.messages : [];
  const lastUserMessage = messages.findLast(
    (message) => isPlainObject(message) && message.role === "user",
  );
  if (!lastUserMessage || !isPlainObject(lastUserMessage)) return input;

  const text = extractRunMessageText(lastUserMessage.content);
  if (!text) return input;

  const paths = extractFileMentions(text, knownFiles);
  if (paths.length === 0) return input;

  const existingContext = input.context ?? [];
  const fileContext = paths.map((path) => ({
    description: "mentioned-file",
    value: path,
  }));

  return {
    ...input,
    context: [...existingContext, ...fileContext],
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

// 新 run 清 cancelled 标记 + RUN_ERROR 转可见消息
export function interceptRunEvents(
  input: RunAgentInput,
  events: ReturnType<import("@ag-ui/client").HttpAgent["run"]>,
): ReturnType<import("@ag-ui/client").HttpAgent["run"]> {
  return new Observable<BaseEvent>((subscriber) => {
    const sub = (events as unknown as Observable<BaseEvent>).subscribe({
      next(event) {
        if (event.type === EventType.RUN_STARTED) {
          // 新 run 开始，清除该 conversation 的 cancelled 标记（input.threadId 即 conversationId）
          const conversationId = input.threadId;
          if (conversationId) {
            useRunSessionStore.getState().clearConversationCancelled(conversationId);
          }
        }

        const nextEvents =
          event.type === EventType.RUN_ERROR
            ? visibleRunErrorEvents(input, event)
            : [event];

        for (const nextEvent of nextEvents) subscriber.next(nextEvent);
      },
      error(error) {
        subscriber.error(error);
      },
      complete() {
        subscriber.complete();
      },
    });

    return () => {
      sub.unsubscribe();
    };
  }) as unknown as ReturnType<import("@ag-ui/client").HttpAgent["run"]>;
}
