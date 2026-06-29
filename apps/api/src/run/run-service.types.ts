import type { Response } from "express";
import type { AgentProviderConfig } from "@agework/shared/protocol";
import type { AssistantUserMessage } from "../conversation/conversation.types";

/**
 * run 启动所需的 workspace 视图（目录 + runtime 配置 + 属主用户名）。
 * 由 agent 层经 WorkspaceService 解析后传入；run 层不直接读 workspace 表
 * （workspace 在依赖图中位于 run 之上，run 不能反向依赖 workspace）。
 */
export type RunWorkspaceView = {
  workspaceId: string;
  workspaceRootPath: string;
  runtimeType?: string;
  isolationScope?: string | null;
  sandboxEngine?: string | null;
  username: string;
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
  workspace: RunWorkspaceView;
  /** 透传给 worker 的运行输入（含 forwardedProps / messages）。 */
  input: unknown;
  userMessage?: AssistantUserMessage;
  userMessageId?: string;
  res: Response;
  interruptReason?: "user_steered";
};
