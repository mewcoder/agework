import { create } from 'zustand';
import { generateId } from '@agework/shared';
import type { ConversationId } from './selection-store';

export type { ConversationId };

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

interface RuntimeUiStore {
  isAssistantInGap: boolean;
  cancelledConversations: Set<ConversationId>;
  userSteeredMessageIdsByConversation: Record<ConversationId, Set<string>>;
  pendingRunInterruptReasonsByConversation: Record<ConversationId, IncompleteMessageReason | undefined>;
  completedRunConversationIds: Set<ConversationId>;
  failedRunConversationIds: Set<ConversationId>;
  queuedUserInputsByConversation: Record<ConversationId, QueuedUserInput[]>;
  /** 刷新后回答了 pending question，需要重新 resume 接上 SSE 流的 conversation 集合 */
  pendingQuestionRepliedConversations: Set<ConversationId>;
  setIsAssistantInGap: (inGap: boolean) => void;
  markConversationCancelled: (conversationId: ConversationId) => void;
  clearConversationCancelled: (conversationId: ConversationId) => void;
  markConversationUserSteered: (conversationId: ConversationId, messageId?: string) => void;
  clearConversationUserSteered: (conversationId: ConversationId) => void;
  consumePendingRunInterruptReason: (conversationId: ConversationId) => IncompleteMessageReason | undefined;
  markConversationRunComplete: (conversationId: ConversationId) => void;
  markConversationRunFailed: (conversationId: ConversationId) => void;
  clearConversationRunFinished: (conversationId: ConversationId) => void;
  clearRunStatusForConversation: (conversationId: ConversationId) => void;
  enqueueUserInput: (conversationId: ConversationId, text: string) => void;
  updateUserInput: (conversationId: ConversationId, inputId: string, text: string) => void;
  prioritizeUserInput: (conversationId: ConversationId, inputId: string) => void;
  removeUserInput: (conversationId: ConversationId, inputId: string) => void;
  shiftUserInput: (conversationId: ConversationId) => QueuedUserInput | undefined;
  markPendingQuestionReplied: (conversationId: ConversationId) => void;
  consumePendingQuestionReplied: (conversationId: ConversationId) => boolean;
}

export const useRuntimeUiStore = create<RuntimeUiStore>((set) => ({
  isAssistantInGap: false,
  cancelledConversations: new Set(),
  userSteeredMessageIdsByConversation: {},
  pendingRunInterruptReasonsByConversation: {},
  completedRunConversationIds: new Set(),
  failedRunConversationIds: new Set(),
  queuedUserInputsByConversation: {},
  pendingQuestionRepliedConversations: new Set(),
  setIsAssistantInGap: (inGap) => set({ isAssistantInGap: inGap }),
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
  markConversationRunComplete: (conversationId) => {
    set((state) => {
      if (state.completedRunConversationIds.has(conversationId) && !state.failedRunConversationIds.has(conversationId)) {
        return state;
      }
      const next = new Set(state.completedRunConversationIds);
      const failed = new Set(state.failedRunConversationIds);
      next.add(conversationId);
      failed.delete(conversationId);
      return { completedRunConversationIds: next, failedRunConversationIds: failed };
    });
  },
  markConversationRunFailed: (conversationId) => {
    set((state) => {
      if (state.failedRunConversationIds.has(conversationId) && !state.completedRunConversationIds.has(conversationId)) {
        return state;
      }
      const completed = new Set(state.completedRunConversationIds);
      const failed = new Set(state.failedRunConversationIds);
      completed.delete(conversationId);
      failed.add(conversationId);
      return { completedRunConversationIds: completed, failedRunConversationIds: failed };
    });
  },
  clearConversationRunFinished: (conversationId) => {
    set((state) => {
      if (!state.completedRunConversationIds.has(conversationId) && !state.failedRunConversationIds.has(conversationId)) {
        return state;
      }
      const completed = new Set(state.completedRunConversationIds);
      const failed = new Set(state.failedRunConversationIds);
      completed.delete(conversationId);
      failed.delete(conversationId);
      return { completedRunConversationIds: completed, failedRunConversationIds: failed };
    });
  },
  clearRunStatusForConversation: (conversationId) => {
    set((state) => {
      const completed = new Set(state.completedRunConversationIds);
      const failed = new Set(state.failedRunConversationIds);
      completed.delete(conversationId);
      failed.delete(conversationId);
      return { completedRunConversationIds: completed, failedRunConversationIds: failed };
    });
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
