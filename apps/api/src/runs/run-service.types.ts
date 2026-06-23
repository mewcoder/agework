import type { Response } from "express";
import type { AgentProviderConfig } from "@agework/shared/protocol";
import type { AssistantUserMessage } from "../conversations/conversation.service";

/** 启动 run 所需的工作空间上下文（agent 层从 conversation/workspace 读取后传入）。 */
export type StartRunWorkspace = {
  workspaceId: string;
  workspaceRootPath: string;
  runtimeType?: string;
  isolationScope?: string | null;
  sandboxEngine?: string | null;
};

/**
 * RunService.start 的唯一入参：意图级。agent 层只负责把请求翻成它——
 * placement 解析、RunConfig 组装、并发守卫、消息持久化、aggregator/saveRun、
 * 启动 worker 等全部由 RunService 内部完成。
 */
export type StartRunInput = {
  runId: string;
  conversationId: string;
  userId: string;
  agentProviderConfig: AgentProviderConfig;
  /** 仅用于触发标题生成。 */
  modelProviderId: string;
  /** 透传给 worker 的运行输入（含 forwardedProps / messages）。 */
  input: unknown;
  workspace: StartRunWorkspace;
  userMessage?: AssistantUserMessage;
  userMessageId?: string;
  res: Response;
  interruptReason?: "user_steered";
};
