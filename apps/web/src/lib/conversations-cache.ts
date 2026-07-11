/**
 * react-query 里 `["conversations", ...]` 缓存的唯一写入点。
 *
 * 会话列表页轮询后台运行状态、停止运行、新建会话这几个场景都需要在不重新
 * 请求接口的前提下，直接改这份缓存里某条（或新增一条）会话数据，让侧边栏
 * 立刻反映最新状态。这里统一处理"遍历哪些 query key、跳过 archived 变体、
 * 按 conversationId 找到目标"这套机制，调用方只需要说清楚自己要做哪种语义
 * 操作（合并新状态 / 设置运行状态 / 插入新会话），不用关心缓存结构细节。
 */

import type { QueryClient } from '@tanstack/react-query';
import type { Conversation } from '@/api/conversations';

type ConversationsCache = { conversations: Conversation[] };

/**
 * 遍历所有 `["conversations", ...]` 缓存条目（跳过 archived 变体——归档列表不应
 * 随运行状态变化刷新），对每条整体应用 updater 并写回。
 */
function updateConversationCaches(
  qc: QueryClient,
  updater: (old: ConversationsCache) => ConversationsCache,
): void {
  for (const [queryKey, old] of qc.getQueriesData<ConversationsCache>({
    queryKey: ['conversations'],
  })) {
    if (queryKey[1] === 'archived') continue;
    if (!old) continue;
    qc.setQueryData<ConversationsCache>(queryKey, updater(old));
  }
}

/** 按 conversationId 找到目标会话并替换；找不到时整份缓存不变。 */
function mapConversationById(
  qc: QueryClient,
  conversationId: string,
  patch: (conversation: Conversation) => Conversation | null,
): void {
  updateConversationCaches(qc, (old) => ({
    ...old,
    conversations: old.conversations.map((conversation) =>
      conversation.conversationId === conversationId
        ? (patch(conversation) ?? conversation)
        : conversation,
    ),
  }));
}

/** 合并轮询到的最新运行状态；仅当 status.updatedAt 比缓存里的更新时才覆盖，避免旧数据覆盖新数据。 */
export function mergeConversationStatusIfNewer(
  qc: QueryClient,
  conversationId: string,
  status: Pick<Conversation, 'runStatus' | 'pendingUserAction' | 'updatedAt'>,
): void {
  mapConversationById(qc, conversationId, (conversation) =>
    status.updatedAt <= conversation.updatedAt ? null : { ...conversation, ...status },
  );
}

/** 无条件设置一个会话的运行状态（stop/running/error 等场景共用）。 */
export function setConversationRunStatus(
  qc: QueryClient,
  conversationId: string,
  runStatus: Conversation['runStatus'],
): void {
  mapConversationById(qc, conversationId, (conversation) => ({ ...conversation, runStatus }));
}

/**
 * 停止运行这类「后端终态异步落库」场景的运行状态乐观写。
 *
 * 后端 stop 返回时 run 只是标成 cancelling，conversation 真正落 idle 要等 worker
 * 取消回流,中间有最长约一两秒的窗口。此时立即 invalidate 会 refetch 到仍是
 * running 的旧值,把刚写的乐观状态冲掉(UI 出现 idle→running→idle 闪变)。
 * 所以这里只做乐观写 + 延迟一次 invalidate 校准权威值,不立即刷新。
 */
export function setConversationRunStatusOptimistic(
  qc: QueryClient,
  conversationId: string,
  runStatus: Conversation['runStatus'],
  options: { revalidateAfterMs: number },
): void {
  setConversationRunStatus(qc, conversationId, runStatus);
  window.setTimeout(() => {
    void qc.invalidateQueries({ queryKey: ['conversations'] });
  }, options.revalidateAfterMs);
}

/** 把一个新会话插到列表最前面；若同 id 已存在（例如乐观创建后又收到一次），去重后再插入。 */
export function upsertConversationAtFront(qc: QueryClient, conversation: Conversation): void {
  updateConversationCaches(qc, (old) => ({
    ...old,
    conversations: [
      conversation,
      ...old.conversations.filter((c) => c.conversationId !== conversation.conversationId),
    ],
  }));
}
