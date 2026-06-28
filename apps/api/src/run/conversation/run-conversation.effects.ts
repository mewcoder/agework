import { Injectable } from "@nestjs/common";
import type { RunConversationPort } from "../run-service.types";

/**
 * runs 对 conversation 聚合的写入端口。
 *
 * run 层决定何时更新会话状态；ConversationService 仍然拥有实际字段写入。
 */
@Injectable()
export class RunConversationEffects {
  private port?: RunConversationPort;

  setPort(port: RunConversationPort): void {
    this.port = port;
  }

  assertOwned(userId: string, conversationId: string): Promise<void> {
    return this.requirePort().assertOwned(userId, conversationId);
  }

  markRunning(conversationId: string): Promise<boolean> {
    return this.requirePort().markRunning(conversationId);
  }

  markError(conversationId: string): Promise<boolean> {
    return this.requirePort().markError(conversationId);
  }

  setActiveRunStatus(
    conversationId: string,
    status: Parameters<RunConversationPort["setActiveRunStatus"]>[1]
  ): Promise<boolean> {
    return this.requirePort().setActiveRunStatus(conversationId, status);
  }

  setPendingUserAction(
    conversationId: string,
    pendingUserAction: Parameters<RunConversationPort["setPendingUserAction"]>[1]
  ): Promise<void> {
    return this.requirePort().setPendingUserAction(
      conversationId,
      pendingUserAction
    );
  }

  saveAgentSessionId(
    conversationId: string,
    agentSessionId: string
  ): Promise<void> {
    return this.requirePort().saveAgentSessionId(
      conversationId,
      agentSessionId
    );
  }

  saveUserMessage(
    conversationId: string,
    userMessage: Parameters<RunConversationPort["saveUserMessage"]>[1]
  ): Promise<void> {
    return this.requirePort().saveUserMessage(conversationId, userMessage);
  }

  generateTitleIfNeeded(
    input: Parameters<RunConversationPort["generateTitleIfNeeded"]>[0]
  ): Promise<void> {
    return this.requirePort().generateTitleIfNeeded(input);
  }

  upsertMessage(
    conversationId: string,
    data: Parameters<RunConversationPort["upsertMessage"]>[1]
  ): Promise<void> {
    return this.requirePort().upsertMessage(conversationId, data);
  }

  attachMessageToRun(
    conversationId: string,
    messageId: string,
    runId: string
  ): Promise<unknown> {
    return this.requirePort().attachMessageToRun(
      conversationId,
      messageId,
      runId
    );
  }

  private requirePort(): RunConversationPort {
    if (!this.port) {
      throw new Error("Run conversation port has not been configured");
    }
    return this.port;
  }
}
