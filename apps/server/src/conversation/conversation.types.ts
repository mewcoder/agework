import type { AgentProviderConfig } from "@agework/shared/protocol";

/**
 * 来自 assistant-ui 的用户消息形状（id / parentId 命名两种风格 + content）。
 * 作为 conversations 领域的后端跨模块契约，供 agent 入参与 runs 使用。
 */
export type AssistantUserMessage = {
  id?: unknown;
  parentId?: unknown;
  parent_id?: unknown;
  content?: unknown;
};

/**
 * Run 执行层向 conversation 持久化消息的输入联合类型。
 * 由 ConversationService.persistConversationMessage 分发到对应的落库方法。
 */
export type ConversationMessageInput =
  | {
      type: "saveUserMessage";
      userMessage: AssistantUserMessage;
      titleContext?: {
        agentType: AgentProviderConfig["agentType"];
        modelProviderId?: string | null;
      };
    }
  | {
      type: "upsertMessage";
      data: {
        id: string;
        runId?: string;
        parent_id: string | null;
        format: string;
        content: unknown;
      };
    }
  | { type: "attachMessageToRun"; messageId: string; runId: string }
  | { type: "setAgentSessionId"; sessionId: string };
