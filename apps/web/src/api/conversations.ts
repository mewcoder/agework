import { apiGet, apiPost } from '@/lib/http';
import type {
  ConversationListResponse,
  ConversationRunStatusListResponse,
  ConversationResponse,
  ConversationSearchHit,
  ConversationSearchResponse,
  ConversationStatus,
  CreateConversationRequest,
  StoredMessage,
  StoredMessageListResponse,
  SubmitQuestionAnswerRequest,
} from '@agework/shared/api';

export type { ConversationResponse as Conversation };
export type { StoredMessage };
export type { ConversationSearchHit };

export const conversationsApi = {
  list: async (after?: string, status?: ConversationStatus, sort?: 'updatedAt' | 'createdAt') => {
    const params = new URLSearchParams();
    if (after) params.set('after', after);
    if (status) params.set('status', status);
    if (sort) params.set('sort', sort);
    const qs = params.toString();
    const result = await apiGet<ConversationListResponse>(qs ? `/api/v1/conversations/list?${qs}` : '/api/v1/conversations/list');
    return { conversations: result.list };
  },

  create: async (body: CreateConversationRequest) => {
    const conversation = await apiPost<ConversationResponse>('/api/v1/agent/create-conversation', body);
    return conversation;
  },

  get: (conversationId: string) =>
    apiGet<ConversationResponse>(`/api/v1/conversations/query?id=${conversationId}`),

  statuses: async (ids: string[]) => {
    const result = await apiPost<ConversationRunStatusListResponse>(
      '/api/v1/conversations/statuses/query',
      { ids },
    );
    return { statuses: result.list };
  },

  rename: (conversationId: string, title: string) =>
    apiPost('/api/v1/conversations/update', { id: conversationId, title }),

  archive: (conversationId: string) =>
    apiPost('/api/v1/conversations/archive', { id: conversationId }),

  unarchive: (conversationId: string) =>
    apiPost('/api/v1/conversations/unarchive', { id: conversationId }),

  delete: (conversationId: string) =>
    apiPost('/api/v1/conversations/remove', { id: conversationId }),

  clearArchived: () =>
    apiPost('/api/v1/conversations/clear-archived'),

  stopRun: (conversationId: string) =>
    apiPost('/api/v1/agent/stop', { id: conversationId }),

  submitQuestionAnswer: (
    conversationId: string,
    answers: SubmitQuestionAnswerRequest['answers'],
  ) =>
    apiPost('/api/v1/agent/reply', {
      id: conversationId,
      answers,
    }),

  listMessages: async (conversationId: string) => {
    const result = await apiGet<StoredMessageListResponse>(
      `/api/v1/conversations/messages/list?id=${conversationId}`,
    );
    return result.list;
  },

  search: async (q: string, limit = 20) => {
    const params = new URLSearchParams({ q });
    if (limit) params.set('limit', String(limit));
    const result = await apiGet<ConversationSearchResponse>(
      `/api/v1/conversations/search?${params.toString()}`,
    );
    return { hits: result.list };
  },
};
