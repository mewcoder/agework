import { Injectable } from "@nestjs/common";
import type {
  ConversationActiveRunStatus,
  ConversationPendingUserAction,
} from "@agework/shared/api";
import { ConversationService } from "../../conversations/conversation.service";

/**
 * runs 对 conversation 聚合的写入端口。
 *
 * run 层决定何时更新会话状态；ConversationService 仍然拥有实际字段写入。
 */
@Injectable()
export class RunConversationEffects {
  constructor(private readonly conversations: ConversationService) {}

  markRunning(conversationId: string): Promise<boolean> {
    return this.conversations.setActiveRunStatus(conversationId, "running");
  }

  markError(conversationId: string): Promise<boolean> {
    return this.conversations.setActiveRunStatus(conversationId, "error");
  }

  setActiveRunStatus(
    conversationId: string,
    status: ConversationActiveRunStatus
  ): Promise<boolean> {
    return this.conversations.setActiveRunStatus(conversationId, status);
  }

  setPendingUserAction(
    conversationId: string,
    pendingUserAction: ConversationPendingUserAction
  ): Promise<void> {
    return this.conversations.setPendingUserAction(
      conversationId,
      pendingUserAction
    );
  }

  saveAgentSessionId(
    conversationId: string,
    agentSessionId: string
  ): Promise<void> {
    return this.conversations.setAgentSessionId(
      conversationId,
      agentSessionId
    );
  }
}
