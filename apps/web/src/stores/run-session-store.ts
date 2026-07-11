import { create } from 'zustand';
import { generateId } from '@agework/shared';
import type { ConversationId } from './selection-store';

export type QueuedUserInput = {
  id: string;
  text: string;
  createdAt: string;
};

export type IncompleteMessageReason =
  | "streaming"
  | "cancelled"
  | "error"
  | "user_steered";

function createQueuedInputId() {
  return generateId();
}

/**
 * RunSession：一次对话「运行生命周期」的归属模块。
 *
 * 权威的 runStatus（idle/running/error）仍存在 react-query 的 conversations 缓存里
 * ——它是服务端轮询的落点。RunSession 不复制它，只拥有那些从 runStatus 派生、
 * 或纯前端会话期的状态。第一块落地的是侧边栏「后台对话刚跑完」的完成提示：
 *
 * 后台（非当前选中）对话从 running 变成 idle 时，记一个「未确认完成」，侧边栏据此
 * 显示完成小圆点；用户打开该对话即确认清除。这套 running→idle 的转换检测原先散在
 * use-conversation-run-status-monitor 里，现在收进这里，喂两次轮询快照即可断言。
 *
 * 注意：失败提示不在这里——它可直接由 runStatus === 'error' 派生，无需单独记账。
 */
interface RunSessionStore {
  /** 上一次同步时正在运行的对话集合，仅用于 diff 出 running→idle 转换。 */
  previousRunningIds: Set<ConversationId>;
  /** 已跑完但用户还没打开过的后台对话，侧边栏据此显示完成提示。 */
  unacknowledgedCompletions: Set<ConversationId>;

  // ── 打断：取消 / 用户引导 ────────────────────────────────────────────────
  /** 用户点了停止、正在取消中的对话（assistant 消息据此渲染「已取消」）。 */
  cancelledConversations: Set<ConversationId>;
  /** 被用户「引导」（steer）打断的 assistant 消息，per 对话记 messageId 供渲染。 */
  userSteeredMessageIdsByConversation: Record<ConversationId, Set<string>>;
  /** 下一次 run 启动时要透传的打断原因（取消 / 引导），启动时消费一次。 */
  pendingRunInterruptReasonsByConversation: Record<ConversationId, IncompleteMessageReason | undefined>;

  // ── 排队输入：run 进行中排队、结束后依次发出 ───────────────────────────────
  queuedUserInputsByConversation: Record<ConversationId, QueuedUserInput[]>;

  /** 刷新后回答了 pending question、需要手动 resume 接上 SSE 流的 conversation 集合。 */
  pendingQuestionRepliedConversations: Set<ConversationId>;

  markConversationCancelled: (conversationId: ConversationId) => void;
  clearConversationCancelled: (conversationId: ConversationId) => void;
  markConversationUserSteered: (conversationId: ConversationId, messageId?: string) => void;
  clearConversationUserSteered: (conversationId: ConversationId) => void;
  consumePendingRunInterruptReason: (conversationId: ConversationId) => IncompleteMessageReason | undefined;
  enqueueUserInput: (conversationId: ConversationId, text: string) => void;
  updateUserInput: (conversationId: ConversationId, inputId: string, text: string) => void;
  prioritizeUserInput: (conversationId: ConversationId, inputId: string) => void;
  removeUserInput: (conversationId: ConversationId, inputId: string) => void;
  shiftUserInput: (conversationId: ConversationId) => QueuedUserInput | undefined;
  /**
   * 用最新一批对话运行状态对账：检测后台对话的 running→idle 转换标记为未确认完成，
   * 重新进入 running 的对话清掉旧提示。selectedId 对应的对话不提示（用户正看着）。
   */
  syncPolledStatuses: (
    conversations: ReadonlyArray<{ conversationId: ConversationId; runStatus: string }>,
    selectedConversationId: ConversationId | undefined,
  ) => void;
  /** 用户打开了某对话，确认并清除它的完成提示。 */
  acknowledgeCompletion: (conversationId: ConversationId) => void;
  markPendingQuestionReplied: (conversationId: ConversationId) => void;
  consumePendingQuestionReplied: (conversationId: ConversationId) => boolean;
}

export const useRunSessionStore = create<RunSessionStore>((set) => ({
  previousRunningIds: new Set(),
  unacknowledgedCompletions: new Set(),
  cancelledConversations: new Set(),
  userSteeredMessageIdsByConversation: {},
  pendingRunInterruptReasonsByConversation: {},
  queuedUserInputsByConversation: {},
  pendingQuestionRepliedConversations: new Set(),
  syncPolledStatuses: (conversations, selectedConversationId) => {
    set((state) => {
      const statusById = new Map<ConversationId, string>();
      const currentRunningIds = new Set<ConversationId>();
      for (const conversation of conversations) {
        statusById.set(conversation.conversationId, conversation.runStatus);
        if (conversation.runStatus === 'running') {
          currentRunningIds.add(conversation.conversationId);
        }
      }

      let completions = state.unacknowledgedCompletions;
      const ensureOwnCopy = () => {
        if (completions === state.unacknowledgedCompletions) {
          completions = new Set(state.unacknowledgedCompletions);
        }
      };

      // 上一轮在跑、这一轮不在跑了：后台对话变 idle 记未确认完成（error 由 runStatus 派生，不记）。
      for (const conversationId of state.previousRunningIds) {
        if (currentRunningIds.has(conversationId)) continue;
        if (conversationId === selectedConversationId) continue;
        if (statusById.get(conversationId) === 'idle' && !completions.has(conversationId)) {
          ensureOwnCopy();
          completions.add(conversationId);
        }
      }

      // 重新进入 running 的对话清掉旧的完成提示。
      for (const conversationId of currentRunningIds) {
        if (completions.has(conversationId)) {
          ensureOwnCopy();
          completions.delete(conversationId);
        }
      }

      return completions === state.unacknowledgedCompletions
        ? { previousRunningIds: currentRunningIds }
        : { previousRunningIds: currentRunningIds, unacknowledgedCompletions: completions };
    });
  },
  acknowledgeCompletion: (conversationId) => {
    set((state) => {
      if (!state.unacknowledgedCompletions.has(conversationId)) return state;
      const next = new Set(state.unacknowledgedCompletions);
      next.delete(conversationId);
      return { unacknowledgedCompletions: next };
    });
  },

  markConversationCancelled: (conversationId) => {
    set((state) => {
      if (state.cancelledConversations.has(conversationId)) return state;
      const next = new Set(state.cancelledConversations);
      next.add(conversationId);
      return { cancelledConversations: next };
    });
  },
  clearConversationCancelled: (conversationId) => {
    set((state) => {
      if (!state.cancelledConversations.has(conversationId)) return state;
      const next = new Set(state.cancelledConversations);
      next.delete(conversationId);
      return { cancelledConversations: next };
    });
  },
  markConversationUserSteered: (conversationId, messageId) => {
    set((state) => {
      const messageIds = new Set(
        state.userSteeredMessageIdsByConversation[conversationId] ?? [],
      );
      if (messageId) messageIds.add(messageId);
      return {
        userSteeredMessageIdsByConversation: {
          ...state.userSteeredMessageIdsByConversation,
          [conversationId]: messageIds,
        },
        pendingRunInterruptReasonsByConversation: {
          ...state.pendingRunInterruptReasonsByConversation,
          [conversationId]: "user_steered",
        },
      };
    });
  },
  clearConversationUserSteered: (conversationId) => {
    set((state) => {
      if (
        !state.userSteeredMessageIdsByConversation[conversationId] &&
        !state.pendingRunInterruptReasonsByConversation[conversationId]
      ) {
        return state;
      }
      const messageIdsByConversation = { ...state.userSteeredMessageIdsByConversation };
      delete messageIdsByConversation[conversationId];
      const pending = { ...state.pendingRunInterruptReasonsByConversation };
      delete pending[conversationId];
      return {
        userSteeredMessageIdsByConversation: messageIdsByConversation,
        pendingRunInterruptReasonsByConversation: pending,
      };
    });
  },
  consumePendingRunInterruptReason: (conversationId) => {
    let reason: IncompleteMessageReason | undefined;
    set((state) => {
      reason = state.pendingRunInterruptReasonsByConversation[conversationId];
      if (!reason) return state;
      const next = { ...state.pendingRunInterruptReasonsByConversation };
      delete next[conversationId];
      return { pendingRunInterruptReasonsByConversation: next };
    });
    return reason;
  },
  enqueueUserInput: (conversationId, text) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    set((state) => {
      const existing = state.queuedUserInputsByConversation[conversationId] ?? [];
      return {
        queuedUserInputsByConversation: {
          ...state.queuedUserInputsByConversation,
          [conversationId]: [
            ...existing,
            {
              id: createQueuedInputId(),
              text: trimmed,
              createdAt: new Date().toISOString(),
            },
          ],
        },
      };
    });
  },
  updateUserInput: (conversationId, inputId, text) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    set((state) => {
      const existing = state.queuedUserInputsByConversation[conversationId] ?? [];
      const idx = existing.findIndex((item) => item.id === inputId);
      if (idx === -1) return state;
      const next = [...existing];
      next[idx] = { ...next[idx], text: trimmed };
      return {
        queuedUserInputsByConversation: {
          ...state.queuedUserInputsByConversation,
          [conversationId]: next,
        },
      };
    });
  },
  prioritizeUserInput: (conversationId, inputId) => {
    set((state) => {
      const existing = state.queuedUserInputsByConversation[conversationId] ?? [];
      const target = existing.find((item) => item.id === inputId);
      if (!target || existing[0]?.id === inputId) return state;
      return {
        queuedUserInputsByConversation: {
          ...state.queuedUserInputsByConversation,
          [conversationId]: [
            target,
            ...existing.filter((item) => item.id !== inputId),
          ],
        },
      };
    });
  },
  removeUserInput: (conversationId, inputId) => {
    set((state) => {
      const existing = state.queuedUserInputsByConversation[conversationId] ?? [];
      if (!existing.some((item) => item.id === inputId)) return state;
      const next = existing.filter((item) => item.id !== inputId);
      return {
        queuedUserInputsByConversation: {
          ...state.queuedUserInputsByConversation,
          [conversationId]: next,
        },
      };
    });
  },
  shiftUserInput: (conversationId) => {
    let shifted: QueuedUserInput | undefined;
    set((state) => {
      const existing = state.queuedUserInputsByConversation[conversationId] ?? [];
      if (existing.length === 0) return state;
      shifted = existing[0];
      return {
        queuedUserInputsByConversation: {
          ...state.queuedUserInputsByConversation,
          [conversationId]: existing.slice(1),
        },
      };
    });
    return shifted;
  },
  markPendingQuestionReplied: (conversationId) => {
    set((state) => {
      if (state.pendingQuestionRepliedConversations.has(conversationId)) return state;
      const next = new Set(state.pendingQuestionRepliedConversations);
      next.add(conversationId);
      return { pendingQuestionRepliedConversations: next };
    });
  },
  consumePendingQuestionReplied: (conversationId) => {
    let wasReplied = false;
    set((state) => {
      if (!state.pendingQuestionRepliedConversations.has(conversationId)) return state;
      wasReplied = true;
      const next = new Set(state.pendingQuestionRepliedConversations);
      next.delete(conversationId);
      return { pendingQuestionRepliedConversations: next };
    });
    return wasReplied;
  },
}));
