import type { AssistantUserMessage } from "../conversations/conversation.service";

/**
 * POST /agent/run 请求体。除已知字段外，原样透传给 RunConfig.input
 * （AG-UI 协议的其余字段，如 tools/state 等）。
 * `threadId` 是 AG-UI 协议字段，值等于 AgeWork `conversationId`。
 */
export interface RunAgentInput {
  threadId: string;
  runId?: string;
  interruptReason?: "user_steered";
  messages?: AssistantUserMessage[];
  forwardedProps?: {
    agentType?: string;
    modelProviderId?: string;
    model?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}
