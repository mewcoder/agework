import type { Response } from "express";
import type { AgentProviderConfig } from "@agework/shared/protocol";
import type { AssistantUserMessage } from "../conversation/conversation.types";
import type { WorkspaceRunContext } from "../workspace/workspace.types";

/**
 * RunService.start 的唯一入参：意图级。agent 层只负责把请求翻成它——
 * placement 解析、并发守卫、消息持久化、aggregator/saveRun、提交执行面等
 * 全部由 RunService 内部完成。CLI 路径等执行机细节由 Runtime Host 侧合成，
 * 不再经这里传递（目标架构 §4.2 字段级决策）。
 */
export type StartRunInput = {
  runId: string;
  conversationId: string;
  userId: string;
  agentProviderConfig: AgentProviderConfig;
  /** 仅用于触发标题生成。 */
  modelProviderId: string;
  workspace: WorkspaceRunContext;
  /** 透传给 worker 的运行输入（含 forwardedProps / messages）。 */
  input: unknown;
  userMessage?: AssistantUserMessage;
  userMessageId?: string;
  res: Response;
  interruptReason?: "user_steered";
};
