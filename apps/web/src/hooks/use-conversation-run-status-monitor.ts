import { useEffect, useRef } from "react";
import { useRuntimeUiStore } from "@/stores/runtime-ui-store";
import type { Conversation } from "@/hooks/use-conversation";

/**
 * 监控会话列表中后台运行状态的变化，
 * 当非当前会话的运行完成/失败时更新 runtime-ui-store，
 * 以便侧边栏显示对应的状态指示器。
 */
export function useConversationRunStatusMonitor(
  conversations: Conversation[],
  selectedConversationId: string | undefined,
) {
  const previousRunningConversationIdsRef = useRef<Set<string> | null>(null);

  useEffect(() => {
    if (conversations.length === 0 && previousRunningConversationIdsRef.current === null) return;

    const runStatusById = new Map<string, Conversation["activeRunStatus"]>();
    const runningConversationIds = new Set<string>();
    for (const conversation of conversations) {
      runStatusById.set(conversation.conversationId, conversation.activeRunStatus);
      if (conversation.activeRunStatus === "running") runningConversationIds.add(conversation.conversationId);
    }

    const previousRunningConversationIds = previousRunningConversationIdsRef.current;
    if (previousRunningConversationIds) {
      const store = useRuntimeUiStore.getState();
      for (const conversationId of previousRunningConversationIds) {
        const runStatus = runStatusById.get(conversationId);
        if (runStatus === "idle" && conversationId !== selectedConversationId) {
          store.markConversationRunComplete(conversationId);
        } else if (runStatus === "error" && conversationId !== selectedConversationId) {
          store.markConversationRunFailed(conversationId);
        }
      }
      for (const conversationId of runningConversationIds) {
        store.clearConversationRunFinished(conversationId);
      }
    }

    previousRunningConversationIdsRef.current = runningConversationIds;
  }, [selectedConversationId, conversations]);
}
