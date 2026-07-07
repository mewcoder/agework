import type { Response } from "express";
import type { AgentProviderConfig } from "@agework/shared/protocol";
import type { ConversationPendingUserAction } from "@agework/shared/api";
import type { AssistantUserMessage } from "../conversation/conversation.types";
import type { WorkspaceRunContext } from "../workspace/workspace.types";

/** Local runtime 的 CLI 可执行文件路径。 */
export type RunCliPaths = { claude?: string; codex?: string };

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
  workspace: WorkspaceRunContext;
  /** 透传给 worker 的运行输入（含 forwardedProps / messages）。 */
  input: unknown;
  userMessage?: AssistantUserMessage;
  userMessageId?: string;
  res: Response;
  interruptReason?: "user_steered";
  /** Local runtime 的 CLI 路径（由 AgentService 在调用方解析好传入）。*/
  cliPaths?: RunCliPaths;
};

export const CONVERSATION_EFFECTS_PORT = Symbol("ConversationEffectsPort");

/**
 * Run 执行层向 conversation 领域回流的窄契约,方法 ≤3、语义具体。
 * 由 ConversationModule 里的 ConversationService 直接实现，在 AppModule
 * 接线——Run 模块不 import ConversationModule。
 */
export interface ConversationEffectsPort {
  /**
   * 原子激活会话：setRunStatus("running") + 校验归属(findById)，返回是否成功激活。
   * claimRun 的同步守卫：激活失败 = 有活跃 run 占位（返回 false）或会话不存在（抛 NotFoundException）。
   */
  activateConversation(
    conversationId: string,
    userId: string
  ): Promise<boolean>;

  /**
   * 设置会话运行终态 / 中间态：idle / error / pendingUserAction。
   * RunStatusService / RunRecoveryService / RunLauncher(startWorker 失败) 回写。
   */
  setConversationRunState(
    conversationId: string,
    state: {
      runStatus?: "idle" | "running" | "error";
      pendingUserAction?: ConversationPendingUserAction | null;
    }
  ): Promise<void>;

  /**
   * 持久化消息到会话：用户消息落库、assistant 消息 upsert、消息-run 关联、agent session id 回写。
   * 区分消息类型以保持类型安全；底层由 ConversationService 的对应方法实现。
   */
  persistConversationMessage(
    conversationId: string,
    message: ConversationMessageInput
  ): Promise<void>;
}

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
