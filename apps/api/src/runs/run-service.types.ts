import type { Response } from "express";
import type { AdapterRuntimeConfig } from "@agework/shared/protocol";
import type { AssistantUserMessage } from "../conversations/conversation.service";

/**
 * agent 层产出的运行规格：placement-free，只描述"用哪个 agent、怎么配适配器"。
 * RunConfigAssembler 再把它和 placement/run/conversation/workspace 信息组装成 RunConfig。
 */
export type AgentSpec = {
  agentType: string;
  adapter: AdapterRuntimeConfig;
};

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
  agentSpec: AgentSpec;
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
