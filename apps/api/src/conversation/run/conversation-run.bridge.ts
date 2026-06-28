import { Injectable, OnModuleInit } from "@nestjs/common";
import { RunService } from "../../run/run.service";
import { ConversationService } from "../conversation.service";

@Injectable()
export class ConversationRunBridge implements OnModuleInit {
  constructor(
    private readonly conversations: ConversationService,
    private readonly runs: RunService
  ) {}

  async onModuleInit(): Promise<void> {
    await this.runs.setConversationPort({
      assertOwned: async (userId, conversationId) => {
        await this.conversations.findOne(userId, conversationId);
      },
      markRunning: (conversationId) =>
        this.conversations.setActiveRunStatus(conversationId, "running"),
      markError: (conversationId) =>
        this.conversations.setActiveRunStatus(conversationId, "error"),
      setActiveRunStatus: (conversationId, status) =>
        this.conversations.setActiveRunStatus(conversationId, status),
      setPendingUserAction: (conversationId, pendingUserAction) =>
        this.conversations.setPendingUserAction(
          conversationId,
          pendingUserAction
        ),
      saveAgentSessionId: (conversationId, agentSessionId) =>
        this.conversations.setAgentSessionId(conversationId, agentSessionId),
      saveUserMessage: (conversationId, userMessage) =>
        this.conversations.saveUserMessage(conversationId, userMessage),
      generateTitleIfNeeded: (input) =>
        this.conversations.generateTitleIfNeeded(input),
      upsertMessage: (conversationId, data) =>
        this.conversations.upsertMessage(conversationId, data),
      attachMessageToRun: (conversationId, messageId, runId) =>
        this.conversations.attachMessageToRun(conversationId, messageId, runId),
    });
  }
}
