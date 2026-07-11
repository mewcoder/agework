import { useMemo } from "react";
import {
  type AssistantRuntime,
  useAui,
} from "@assistant-ui/react";
import { useQueryClient } from "@tanstack/react-query";
import { useAgUiRuntime } from "@assistant-ui/react-ag-ui";
import { apiUrl } from "@/lib/http";
import { conversationsApi, type Conversation } from "@/api/conversations";
import { useRunSessionStore } from "@/stores/run-session-store";
import { ChatHttpAgent } from "@/lib/runtime/chat-http-agent";
import { createAgentMiddleware } from "@/lib/runtime/agent-middleware";
import { createThreadHistoryAdapter } from "@/lib/runtime/thread-history-adapter";

// remoteId 即 AgeWork 的 conversationId（assistant-ui 边界命名）
function findCachedConversation(
  qc: ReturnType<typeof useQueryClient>,
  remoteId: string,
) {
  const conversationQueries = qc.getQueriesData<{ conversations: Conversation[] }>({
    queryKey: ["conversations"],
  });

  for (const [, data] of conversationQueries) {
    const conversation = data?.conversations.find((item) => item.conversationId === remoteId);
    if (conversation) return conversation;
  }

  return undefined;
}

// ── per-conversation runtime（每个 alive conversation 各调用一次，独立 agent / core / SSE）──
export function useAgentChatRuntime(): AssistantRuntime {
  const aui = useAui();
  const qc = useQueryClient();

  const agent = useMemo(() => {
    const instance = new ChatHttpAgent({
      url: apiUrl("/api/v1/agent/run"),
      headers: {
        Accept: "text/event-stream",
      },
    });

    instance.use(createAgentMiddleware(aui, qc));

    return instance;
  }, [aui, qc]);

  // 显式传入 history adapter，避免依赖 RuntimeAdapterProvider 的注入时序：
  // useAgUiRuntime 的 coreRef 在首次渲染时创建并绑定 historyAdapter，
  // 若此时 runtimeAdapters.history 尚未就绪，core 会缺少 history，
  // __internal_load 的 _loadPromise 守卫又会阻止后续重跑，导致 load 不触发。
  // qc 一并传入：resume 流结束后要手动刷新 conversation.runStatus
  // （resume 绕过了 agent middleware，RUN_FINISHED 不会自动刷新缓存）。
  const history = useMemo(() => createThreadHistoryAdapter(aui, qc), [aui, qc]);

  return useAgUiRuntime({
    agent,
    adapters: { history },
    showThinking: true,
    onCancel: () => {
      const conversationId = aui.threadListItem().getState().remoteId;
      if (!conversationId) return;
      const runSession = useRunSessionStore.getState();
      runSession.clearConversationUserSteered(conversationId);
      runSession.markConversationCancelled(conversationId);
      conversationsApi.stopRun(conversationId).catch((e) => console.error("[useAgentChatRuntime] stopRun failed:", e));
    },
  });
}

// 供 AgentChatRuntimeProvider 使用的 findCachedConversation — 导出以避免重复
export { findCachedConversation };
