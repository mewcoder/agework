import { Injectable } from "@nestjs/common";
import { ConversationService } from "../../conversation/conversation.service";

/**
 * run 对 conversation 聚合的写入边界（run 内部 provider）。
 *
 * run 层决定何时更新会话状态（markRunning / markError 等 run 语义），
 * 实际字段写入仍归 ConversationService。依赖方向 run → conversation（向下），
 * 不再经反向 Port。
 */
@Injectable()
export class RunConversationEffects {
  constructor(private readonly conversations: ConversationService) {}

  async assertOwned(userId: string, conversationId: string): Promise<void> {
    await this.conversations.findOne(userId, conversationId);
  }

  markRunning(conversationId: string): Promise<boolean> {
    return this.conversations.setActiveRunStatus(conversationId, "running");
  }

  markError(conversationId: string): Promise<boolean> {
    return this.conversations.setActiveRunStatus(conversationId, "error");
  }

  setActiveRunStatus(
    conversationId: string,
    status: Parameters<ConversationService["setActiveRunStatus"]>[1]
  ): Promise<boolean> {
    return this.conversations.setActiveRunStatus(conversationId, status);
  }

  setPendingUserAction(
    conversationId: string,
    pendingUserAction: Parameters<ConversationService["setPendingUserAction"]>[1]
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
    return this.conversations.setAgentSessionId(conversationId, agentSessionId);
  }

  saveUserMessage(
    conversationId: string,
    userMessage: Parameters<ConversationService["saveUserMessage"]>[1]
  ): Promise<void> {
    return this.conversations.saveUserMessage(conversationId, userMessage);
  }

  generateTitleIfNeeded(
    input: Parameters<ConversationService["generateTitleIfNeeded"]>[0]
  ): Promise<void> {
    return this.conversations.generateTitleIfNeeded(input);
  }

  upsertMessage(
    conversationId: string,
    data: Parameters<ConversationService["upsertMessage"]>[1]
  ): Promise<void> {
    return this.conversations.upsertMessage(conversationId, data);
  }

  attachMessageToRun(
    conversationId: string,
    messageId: string,
    runId: string
  ): Promise<unknown> {
    return this.conversations.attachMessageToRun(
      conversationId,
      messageId,
      runId
    );
  }
}
