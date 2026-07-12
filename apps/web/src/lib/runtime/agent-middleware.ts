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
import { FILE_INDEX_KEY } from "@/hooks/use-file-mention";
import {
  createFallbackTitle,
  withRunSettings,
  withFileMentions,
  interceptRunEvents,
} from "@/lib/runtime/agent-run-interceptor";
import {
  clearPendingInitializeTitle,
  setPendingInitializeTitle,
} from "@/lib/runtime/thread-list-adapter";
import {
  conversationKeys,
  setConversationRunState,
  upsertConversationAtFront,
} from "@/lib/conversations-cache";
import {
  conversationStateFromRunFinished,
  RUN_STARTED_CONVERSATION_STATE,
} from "@/stores/run-session-status-rules";

type Aui = ReturnType<typeof useAui>;
type QC = ReturnType<typeof useQueryClient>;

/**
 * 创建 agent 中间件：处理新会话初始化、运行设置注入、线程列表刷新。
 */
export function createAgentMiddleware(
  aui: Aui,
  qc: QC,
): MiddlewareFunction {
  const invalidate = () => qc.invalidateQueries({ queryKey: conversationKeys.all });

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

        // Inject @file mentions into context (SPEC §6)
        // Read file index from TanStack Query cache (workspace-level, loaded by useFileMentionAdapter)
        const fileIndexQueries = qc.getQueriesData<{ list: string[] }>({
          queryKey: FILE_INDEX_KEY,
        });
        const knownFiles = new Set<string>();
        for (const [, data] of fileIndexQueries) {
          if (data?.list) {
            for (const path of data.list) knownFiles.add(path);
          }
        }
        const inputWithFiles = withFileMentions(input, knownFiles);

        if (isNewConversation && fallbackTitle && workspaceId) {
          const now = new Date().toISOString();
          const newConv = {
            conversationId: remoteId,
            title: fallbackTitle,
            workspaceId,
            agentType,
            ...RUN_STARTED_CONVERSATION_STATE,
            status: "regular" as const,
            createdAt: now,
            updatedAt: now,
          } satisfies Conversation;
          upsertConversationAtFront(qc, newConv);
        } else {
          setConversationRunState(qc, remoteId, RUN_STARTED_CONVERSATION_STATE);
        }

        if (subscriber.closed) return;

        innerSub = interceptRunEvents(inputWithFiles, next.run(inputWithFiles)).subscribe({
          next: (e) => {
            if (e.type === EventType.RUN_FINISHED) {
              setConversationRunState(
                qc,
                remoteId,
                conversationStateFromRunFinished(
                  (e as { outcome?: { type?: string } }).outcome,
                ),
              );
            } else if (e.type === EventType.RUN_ERROR) {
              setConversationRunState(qc, remoteId, { runStatus: "error" });
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
