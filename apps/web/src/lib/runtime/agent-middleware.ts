import { Observable } from "rxjs";
import { EventType } from "@ag-ui/client";
import type {
  AbstractAgent,
  BaseEvent,
  RunAgentInput,
  MiddlewareFunction,
} from "@ag-ui/client";
import type { useAui } from "@assistant-ui/react";
import type { useQueryClient } from "@tanstack/react-query";
import type { AgentType } from "@/stores/selection-store";
import type { Conversation } from "@/api/conversations";
import { useSelectionStore } from "@/stores/selection-store";
import {
  createFallbackTitle,
  withRunSettings,
  interceptRunEvents,
} from "@/lib/runtime/agent-run-interceptor";
import {
  clearPendingInitializeTitle,
  setPendingInitializeTitle,
} from "@/lib/runtime/thread-list-adapter";

type Aui = ReturnType<typeof useAui>;
type QC = ReturnType<typeof useQueryClient>;
type ConversationsCache = { conversations: Conversation[] };

function updateRegularConversationCaches(
  qc: QC,
  updater: (old: ConversationsCache | undefined) => ConversationsCache | undefined,
) {
  for (const [queryKey, old] of qc.getQueriesData<ConversationsCache>({
    queryKey: ["conversations"],
  })) {
    if (queryKey[1] === "archived") continue;
    qc.setQueryData<ConversationsCache>(queryKey, updater(old));
  }
}

function setConversationRunStatus(
  qc: QC,
  conversationId: string,
  activeRunStatus: Conversation["activeRunStatus"],
) {
  updateRegularConversationCaches(qc, (old) => {
    if (!old) return old;
    return {
      ...old,
      conversations: old.conversations.map((conversation) =>
        conversation.conversationId === conversationId
          ? { ...conversation, activeRunStatus }
          : conversation,
      ),
    };
  });
}

/**
 * 创建 agent 中间件：处理新会话初始化、运行设置注入、线程列表刷新。
 */
export function createAgentMiddleware(
  aui: Aui,
  qc: QC,
): MiddlewareFunction {
  const invalidate = () => qc.invalidateQueries({ queryKey: ["conversations"] });

  return ((params: RunAgentInput, next: AbstractAgent) =>
    new Observable<BaseEvent>((subscriber) => {
      let innerSub: { unsubscribe: () => void } | null = null;
      (async () => {
        const state = useSelectionStore.getState();
        const fallbackTitle = createFallbackTitle(params);
        const workspaceId = state.selectedWorkspaceId;

        let remoteId = aui.threadListItem().getState().remoteId;
        let isNewConversation = false;
        if (!remoteId) {
          if (!workspaceId) {
            throw new Error("缺少工作空间，无法创建会话");
          }
          setPendingInitializeTitle(fallbackTitle);
          const res = await aui.threadListItem().initialize();
          remoteId = res.remoteId;
          isNewConversation = true;
        }
        if (subscriber.closed) return;

        const custom = aui.threadListItem().getState().custom as
          | { agentType?: AgentType }
          | undefined;
        const agentType = custom?.agentType ?? state.selectedAgentType;
        const input = withRunSettings(params, remoteId, agentType, state);

        if (isNewConversation && fallbackTitle && workspaceId) {
          const now = new Date().toISOString();
          updateRegularConversationCaches(
            qc,
            (old) => {
              const newConv = {
                conversationId: remoteId,
                title: fallbackTitle,
                workspaceId,
                agentType,
                activeRunStatus: "running" as const,
                pendingUserAction: null,
                status: "regular" as const,
                createdAt: now,
                updatedAt: now,
              } satisfies Conversation;
              if (!old) return { conversations: [newConv] };
              const filtered = old.conversations.filter(
                (c) => c.conversationId !== remoteId,
              );
              return {
                ...old,
                conversations: [newConv, ...filtered],
              };
            },
          );
        } else {
          setConversationRunStatus(qc, remoteId, "running");
        }

        if (subscriber.closed) return;

        innerSub = interceptRunEvents(input, next.run(input)).subscribe({
          next: (e) => {
            if (e.type === EventType.RUN_FINISHED) {
              setConversationRunStatus(qc, remoteId, "idle");
            } else if (e.type === EventType.RUN_ERROR) {
              setConversationRunStatus(qc, remoteId, "error");
            }
            subscriber.next(e);
          },
          error: (err) => {
            invalidate();
            subscriber.error(err);
          },
          complete: () => {
            invalidate();
            subscriber.complete();
          },
        });
      })().catch((err) => {
        clearPendingInitializeTitle();
        invalidate();
        if (!subscriber.closed) subscriber.error(err);
      });
      return () => {
        clearPendingInitializeTitle();
        innerSub?.unsubscribe();
      };
    })) as unknown as MiddlewareFunction;
}
