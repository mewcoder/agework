import type { AgentType, PendingAction, ListResponse } from "../common";
import type { AgentContextUsage } from "../protocol";

export type ConversationStatus = "regular" | "archived";
export type ConversationRunStatus = "idle" | "running" | "error";
export type ConversationPendingUserAction = PendingAction;

/** 对应 api 端 ConversationService.toConversationDto 的输出。 */
export type ConversationResponse = {
  conversationId: string;
  status: ConversationStatus;
  runStatus: ConversationRunStatus;
  pendingUserAction: ConversationPendingUserAction;
  title?: string;
  workspaceId: string;
  agentType: AgentType;
  agentSessionId?: string;
  /** ISO 8601 */
  createdAt: string;
  /** ISO 8601 */
  updatedAt: string;
};

export type ConversationListResponse = ListResponse<ConversationResponse>;

export type ConversationRunStatusResponse = {
  conversationId: string;
  runStatus: ConversationRunStatus;
  pendingUserAction: ConversationPendingUserAction;
  /** ISO 8601 */
  updatedAt: string;
};

export type ConversationRunStatusListResponse =
  ListResponse<ConversationRunStatusResponse>;

export type StoredMessage = {
  id: string;
  parent_id: string | null;
  format: string;
  content: Record<string, unknown>;
  /** 该消息所属 run 的上下文窗口占用（冷加载喂 context meter），无则省略。 */
  contextUsage?: AgentContextUsage;
};

export type StoredMessageListResponse = ListResponse<StoredMessage>;

export type CreateConversationRequest = {
  workspaceId: string;
  firstMessage?: string;
  agentType?: AgentType;
  title?: string;
};

export type UpdateConversationRequest = {
  id: string;
  title?: string;
  status?: string;
};

export type ConversationIdRequest = { id: string };

export type QueryConversationRunStatusesRequest = { ids: string[] };

export type SubmitQuestionAnswerRequest = {
  id: string;
  answers: Record<string, string | string[]>;
};

/** 搜索命中的字段来源。 */
export type ConversationSearchMatchedField = "title" | "message";

export type ConversationSearchHit = {
  conversation: ConversationResponse;
  matchedField: ConversationSearchMatchedField;
  /** 围绕匹配位置截取的文本片段，已转义；前端负责高亮。 */
  matchedSnippet: string;
};

export type ConversationSearchResponse = ListResponse<ConversationSearchHit>;

export type ConversationSearchRequest = {
  q: string;
  limit?: number;
};
