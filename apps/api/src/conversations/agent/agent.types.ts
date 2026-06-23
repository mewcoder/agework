import type { RunAgentInput as AgUiRunAgentInput } from "@ag-ui/core";
import type { AssistantUserMessage } from "../conversation.service";

export type AgentRunForwardedProps = Record<string, unknown> & {
  agentType?: string;
  modelProviderId?: string;
  model?: string;
};

/**
 * POST /conversations/agent/run request body.
 *
 * This is AgeWork's HTTP boundary type: it accepts the AG-UI run input shape
 * plus AgeWork-specific routing/settings fields. `threadId` is the AG-UI
 * protocol field whose value is the AgeWork conversationId.
 */
export type AgentRunRequestBody = Omit<
  Partial<AgUiRunAgentInput>,
  "threadId" | "runId" | "messages" | "forwardedProps"
> & {
  threadId: string;
  runId?: string;
  interruptReason?: "user_steered";
  messages?: AssistantUserMessage[];
  forwardedProps?: AgentRunForwardedProps;
};
