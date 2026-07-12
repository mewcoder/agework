import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { conversationsApi, type Conversation } from '@/api/conversations';
import { useRunSessionStore } from '@/stores/run-session-store';
import {
  conversationKeys,
  setConversationRunStatusOptimistic,
} from '@/lib/conversations-cache';
export type { Conversation } from '@/api/conversations';
export type { ConversationSearchHit } from '@/api/conversations';

export type ConversationSortKey = 'updatedAt' | 'createdAt';

export function getRegularConversations(conversations: Conversation[]) {
  return [...conversations].filter((c) => c.status !== 'archived');
}

export function useConversations(
  status?: 'regular' | 'archived',
  sort?: ConversationSortKey,
) {
  return useQuery({
    queryKey: conversationKeys.list(status, sort),
    queryFn: () => conversationsApi.list(undefined, status, sort),
  });
}

export function useConversationRunStatuses(conversationIds: string[]) {
  const ids = [...new Set(conversationIds)].filter(Boolean).sort();
  return useQuery({
    queryKey: conversationKeys.runStatuses(ids),
    queryFn: () => conversationsApi.statuses(ids),
    enabled: ids.length > 0,
    refetchInterval: ids.length > 0 ? 5000 : false,
  });
}

export function useRenameConversation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) => conversationsApi.rename(id, title),
    onSuccess: () => qc.invalidateQueries({ queryKey: conversationKeys.all }),
  });
}

export function useArchiveConversation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => conversationsApi.archive(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: conversationKeys.all }),
  });
}

export function useUnarchiveConversation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => conversationsApi.unarchive(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: conversationKeys.all }),
  });
}

export function useDeleteConversation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => conversationsApi.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: conversationKeys.all }),
  });
}

export function useClearArchived() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => conversationsApi.clearArchived(),
    onSuccess: () => qc.invalidateQueries({ queryKey: conversationKeys.all }),
  });
}

/**
 * 会话搜索。仅当 q 非空时启用。
 * 返回 hits 数组（已通过 select 提取）；空查询时不发起请求。
 * 调用方应在搜索输入框做 debounce（建议 300ms）后传入 q。
 */
export function useConversationSearch(q: string, limit = 20) {
  const trimmed = q.trim();
  return useQuery({
    queryKey: conversationKeys.search(trimmed, limit),
    queryFn: () => conversationsApi.search(trimmed, limit),
    enabled: trimmed.length > 0,
    staleTime: 30_000,
    placeholderData: (prev) => prev,
    select: (data) => data.hits,
  });
}

export function useStopConversationRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => conversationsApi.stopRun(id),
    onMutate: (id) => {
      const runSession = useRunSessionStore.getState();
      runSession.clearConversationUserSteered(id);
      runSession.markConversationCancelled(id);
    },
    onError: (_error, id) => {
      useRunSessionStore.getState().clearConversationCancelled(id);
    },
    onSuccess: (_data, id) => {
      // 后端终态异步落库,立即 refetch 会拉回 running 冲掉乐观 idle,延迟校准
      setConversationRunStatusOptimistic(qc, id, 'idle', { revalidateAfterMs: 1500 });
    },
  });
}
