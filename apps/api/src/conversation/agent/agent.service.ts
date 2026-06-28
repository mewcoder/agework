import { Injectable, BadRequestException, Logger } from "@nestjs/common";
import type { Response } from "express";
import { isAgentType, type AgentType } from "@agework/shared";
import type {
  AgentProviderConfig,
  CustomAgentProviderConfig,
} from "@agework/shared/protocol";
import { ConversationService } from "../conversation.service";
import type { JwtUser } from "../../auth/decorators/current-user.decorator";
import { RunService } from "../../run/run.service";
import { WorkspaceService } from "../../workspace/workspace.service";
import { safeLogJson } from "../../common/logging";
import type { AgentRunRequestDto } from "./dto/agent-run.dto";
import { getAgentOptionsByType } from "./agent-options";
import { ModelProviderService } from "../../model-provider/model-provider.service";

type AgentRunUserMessage = NonNullable<AgentRunRequestDto["messages"]>[number];

/**
 * Agent 层入口：把 HTTP 请求翻成 RunService.start 的 StartRunInput。
 * 只负责解析参数、读取 conversation/workspace、产出 agent provider config；
 * placement / RunConfig 组装 / 生命周期 / SSE / 持久化全部交给 RunService。
 */
@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);

  constructor(
    private readonly conversationService: ConversationService,
    private readonly runService: RunService,
    private readonly modelProviderService: ModelProviderService,
    private readonly workspaceService: WorkspaceService
  ) {}

  async run(
    body: AgentRunRequestDto,
    res: Response,
    user: JwtUser
  ): Promise<void> {
    // body.threadId 是 AG-UI 协议字段，值等于 AgeWork conversationId
    const conversationId = body.threadId;
    const runId = body.runId;
    const userId = user.userId;
    const userMessage = this.getLastUserMessage(body);
    const userMessageId = this.normalizeMessageId(userMessage?.id);
    const requestedAgentType = this.normalizeAgentType(
      body.forwardedProps.agentType
    );
    const modelProviderId = body.forwardedProps.modelProviderId.trim();
    const requestedModel = this.optionalString(body.forwardedProps.model);
    const interruptReason = body.interruptReason;

    this.logger.log(
      `agent run requested ${safeLogJson({
        conversationId,
        runId,
        userId,
        userMessageId,
        requestedAgentType,
        requestedModelProviderId: modelProviderId,
        requestedModel,
        interruptReason,
      })}`
    );

    const conversation = await this.conversationService.findOne(
      userId,
      conversationId
    );
    const agentType = this.normalizeAgentType(conversation.agentType);
    if (requestedAgentType !== agentType) {
      throw new BadRequestException(
        `请求 agent 类型 ${requestedAgentType} 与对话 agent 类型 ${agentType} 不一致`
      );
    }
    const agentSessionId = conversation.agentSessionId;
    const workspaceId = conversation.workspaceId;

    if (!workspaceId) {
      throw new BadRequestException(
        "Conversation 必须关联工作空间才能运行 agent"
      );
    }
    const workspace = await this.workspaceService.getRunView(workspaceId);

    const forwardedProps = {
      ...body.forwardedProps,
      agentType,
      modelProviderId,
      ...(requestedModel ? { model: requestedModel } : {}),
    } as Record<string, unknown>;
    this.normalizePermissionForwardedProps(agentType, forwardedProps);

    if (agentSessionId) {
      forwardedProps.agentSessionId = agentSessionId;
      // 持久容器模式下 session 数据在容器内持久化，可以 resume
      if (agentType === "claude") {
        forwardedProps.resume = agentSessionId;
      }
    }

    const runInput = {
      ...body,
      runId,
      forwardedProps,
      ...(agentSessionId && { messages: body.messages?.slice(-1) }),
    };

    // Agent 层只产出 placement-free 的 provider config
    let agentProviderConfig;
    try {
      agentProviderConfig = await this.getAgentProviderConfig({
        agentType,
        modelProviderId,
        model: requestedModel,
      });
    } catch (err) {
      throw new BadRequestException(
        err instanceof Error ? err.message : String(err)
      );
    }

    await this.runService.start({
      runId,
      conversationId,
      userId,
      agentProviderConfig,
      modelProviderId,
      input: runInput,
      workspace,
      userMessage,
      userMessageId,
      res,
      interruptReason,
    });
  }

  /**
   * 刷新网页后续接进行中的 run：校验 conversation 归属后，把 SSE response
   * 交给 RunService.resumeStream 接到活跃 run 上。
   */
  async resume(
    conversationId: string,
    res: Response,
    user: JwtUser
  ): Promise<void> {
    if (!conversationId) {
      throw new BadRequestException("conversationId is required");
    }
    // 校验归属：找不到会抛 NotFound，等价于官方 assertStreamOwner
    await this.conversationService.findOne(user.userId, conversationId);
    await this.runService.resumeStream(conversationId, res);
  }

  /** 回应一次审批（approval_resolved 控制指令）。 */
  async reply(
    conversationId: string,
    answers: Record<string, string | string[]>,
    user: JwtUser
  ): Promise<void> {
    await this.conversationService.findOne(user.userId, conversationId);
    await this.runService.resolveApproval(conversationId, answers);
  }

  /** 停止 conversation 的活跃 run；若无内存 handle 但状态仍为 running 则重置为 idle。 */
  async stop(conversationId: string, user: JwtUser): Promise<void> {
    const conversation = await this.conversationService.findOne(
      user.userId,
      conversationId
    );
    const hadHandle = await this.runService.stop(conversationId);
    if (!hadHandle && conversation.activeRunStatus === "running") {
      await this.conversationService.setActiveRunStatus(conversationId, "idle");
    }
  }

  private getLastUserMessage(
    body: AgentRunRequestDto
  ): AgentRunUserMessage | undefined {
    const messages = body.messages;
    if (!messages?.length) return undefined;
    return messages[messages.length - 1];
  }

  private optionalString(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }

  private normalizeAgentType(agentType: string): AgentType {
    const trimmed = agentType.trim();
    if (!isAgentType(trimmed)) {
      throw new BadRequestException(`不支持的 agent 类型: ${agentType}`);
    }
    return trimmed;
  }

  private normalizeMessageId(messageId: unknown): string | undefined {
    return messageId === undefined || messageId === null
      ? undefined
      : String(messageId);
  }

  private normalizePermissionForwardedProps(
    agentType: AgentType,
    forwardedProps: Record<string, unknown>
  ) {
    if (agentType !== "claude") return;
    const permissionOptions = getAgentOptionsByType().claude.permissionMode;
    const allowed = new Set<string>(
      permissionOptions.options.map((option) => option.value)
    );
    if (
      typeof forwardedProps.permissionMode !== "string" ||
      !allowed.has(forwardedProps.permissionMode)
    ) {
      forwardedProps.permissionMode = permissionOptions.defaultValue;
    }
  }

  private async getAgentProviderConfig(params: {
    agentType: AgentType;
    modelProviderId: string;
    model?: string;
  }): Promise<AgentProviderConfig> {
    const { agentType, modelProviderId, model } = params;

    const resolved = await this.modelProviderService.resolveEnabledProvider(
      agentType,
      modelProviderId
    );

    if (!resolved) {
      throw new BadRequestException(`模型服务不可用: ${modelProviderId}`);
    }

    if (resolved.source === "system") {
      return { agentType, source: "system" };
    }

    if (!model) {
      throw new BadRequestException("未选择模型或模型不在可用列表中");
    }

    const {
      baseUrl,
      apiKey,
      models = [],
      extraConfig = {},
    } = resolved.providerConfig;

    if (!models.includes(model)) {
      throw new BadRequestException(
        `模型 ${model} 不在可用列表中: ${models.join(", ")}`
      );
    }

    const config: CustomAgentProviderConfig = {
      agentType,
      source: "custom",
      baseUrl,
      apiKey,
      model,
      extraConfig,
    };

    return config;
  }
}
