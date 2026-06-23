import { Injectable, BadRequestException, Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { Response } from "express";
import { Prisma } from "../../generated/prisma/client.js";
import { AgentSpecBuilder } from "./agent-spec.builder";
import { ConversationService } from "../conversations/conversation.service";
import type { JwtUser } from "../auth/current-user.decorator";
import { RunService } from "../runs/run.service";
import { safeLogJson } from "../common/logging";
import type { RunAgentInput } from "./run-agent-input";
import { getAgentPermissionOptions } from "./agent-permission-options";

/**
 * Agent 层入口：把 HTTP 请求翻成 RunService.start 的 StartRunInput。
 * 只负责解析参数、读取 conversation/workspace、产出 AgentSpec；
 * placement / RunConfig 组装 / 生命周期 / SSE / 持久化全部交给 RunService。
 */
@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);

  constructor(
    private readonly agentSpecBuilder: AgentSpecBuilder,
    private readonly conversationService: ConversationService,
    private readonly runService: RunService
  ) {}

  async run(body: RunAgentInput, res: Response, user: JwtUser): Promise<void> {
    // body.threadId 是 AG-UI 协议字段，值等于 AgeWork conversationId
    const conversationId = body.threadId;
    const runId =
      typeof body.runId === "string" && body.runId ? body.runId : randomUUID();
    const userId = user.userId;
    const userMessage = body.messages?.[body.messages.length - 1];
    const userMessageId =
      typeof userMessage?.id === "string" && userMessage.id
        ? userMessage.id
        : userMessage?.id !== undefined && userMessage.id !== null
          ? String(userMessage.id)
          : undefined;
    const requestedAgentType = body.forwardedProps?.agentType ?? "claude";
    const requestedModelProviderId =
      typeof body.forwardedProps?.modelProviderId === "string"
        ? body.forwardedProps.modelProviderId
        : undefined;
    const requestedModel =
      typeof body.forwardedProps?.model === "string"
        ? body.forwardedProps.model
        : undefined;
    const interruptReason =
      body.interruptReason === "user_steered"
        ? body.interruptReason
        : undefined;
    this.logger.log(
      `agent run requested ${safeLogJson({
        conversationId,
        runId,
        userId,
        userMessageId,
        requestedAgentType,
        requestedModelProviderId,
        requestedModel,
        interruptReason,
      })}`
    );

    // Determine which agent adapter to use
    let agentType = requestedAgentType;
    const modelProviderId = requestedModelProviderId;
    let agentSessionId: string | undefined;
    let workspaceId: string | undefined;
    let workspaceRootPath: string | undefined;
    let workspaceRuntimeType: string | undefined;
    let workspaceIsolationScope: string | null | undefined;
    let workspaceSandboxEngine: string | null | undefined;

    if (conversationId) {
      try {
        const conversation = await this.conversationService.findOne(
          userId,
          conversationId
        );
        agentType = conversation.agentType ?? agentType;
        agentSessionId = conversation.agentSessionId;
        workspaceId = conversation.workspaceId;
        const workspaceInfo = await this.conversationService.getWorkspaceInfo(
          userId,
          conversationId
        );
        workspaceRootPath = workspaceInfo.rootPath;
        workspaceRuntimeType = workspaceInfo.runtimeType;
        workspaceIsolationScope = workspaceInfo.isolationScope;
        workspaceSandboxEngine = workspaceInfo.sandboxEngine;
      } catch (err) {
        // conversation 不存在（首次发送消息）时使用 forwardedProps 中的 agent 配置；
        // 其他错误（如数据库异常）继续抛出，避免被掩盖成"必须关联工作空间"
        if (
          !(
            err instanceof Prisma.PrismaClientKnownRequestError &&
            err.code === "P2025"
          )
        ) {
          throw err;
        }
      }
    }

    // 对话必须关联工作空间才能运行 agent
    if (!workspaceId || !workspaceRootPath) {
      throw new BadRequestException(
        "Conversation 必须关联工作空间才能运行 agent"
      );
    }
    if (!modelProviderId) {
      throw new BadRequestException("缺少 modelProviderId");
    }

    const forwardedProps = {
      ...(body.forwardedProps ?? {}),
      agentType,
      ...(modelProviderId ? { modelProviderId } : {}),
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

    // Agent 层只产出 placement-free 的 AgentSpec
    let agentSpec;
    try {
      agentSpec = await this.agentSpecBuilder.build({
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
      agentSpec,
      modelProviderId,
      input: runInput,
      workspace: {
        workspaceId,
        workspaceRootPath,
        runtimeType: workspaceRuntimeType,
        isolationScope: workspaceIsolationScope,
        sandboxEngine: workspaceSandboxEngine,
      },
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
  async resumeStream(
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
    answers: Record<string, string | string[]>
  ): Promise<void> {
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

  private normalizePermissionForwardedProps(
    agentType: string,
    forwardedProps: Record<string, unknown>
  ) {
    if (agentType !== "claude") return;
    const permissionOptions = getAgentPermissionOptions().claude.permissionMode;
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
}
