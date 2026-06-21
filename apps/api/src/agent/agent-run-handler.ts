import {
  Injectable,
  BadRequestException,
  ConflictException,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { Response } from "express";
import { Prisma } from "../../generated/prisma/client.js";
import { AgentRunConfigBuilder } from "./agent-run-config-builder";
import { TitleService } from "./title.service";
import { ConversationService } from "../conversations/conversation.service";
import type { JwtUser } from "../auth/current-user.decorator";
import {
  RuntimeMessageAggregator,
  type IncompleteMessageReason,
} from "../runtime/core/runtime-message-aggregator";
import { RuntimeRunner } from "../runtime/core/runtime-runner";
import { RuntimePlacementService } from "../runtime/core/runtime-placement.service";
import {
  ConfigService,
  type IsolationScope,
} from "../config/config.service";
import { swallow } from "../common/swallow";
import { safeLogJson } from "../common/logging";
import type { RunAgentInput } from "./run-agent-input";
import { getAgentPermissionOptions } from "./agent-permission-options";

@Injectable()
export class AgentRunHandler {
  private readonly logger = new Logger(AgentRunHandler.name);

  constructor(
    private readonly runConfigBuilder: AgentRunConfigBuilder,
    private readonly conversationService: ConversationService,
    private readonly titleService: TitleService,
    private readonly runtimeRunner: RuntimeRunner,
    private readonly runtimePlacementService: RuntimePlacementService,
    private readonly configService: ConfigService
  ) {}

  async run(body: RunAgentInput, res: Response, user: JwtUser): Promise<void> {
    // body.threadId 是 AG-UI 协议字段，值等于 AgeWork conversationId
    const conversationId = body.threadId;
    const runId =
      typeof body.runId === "string" && body.runId ? body.runId : randomUUID();
    const userId = user.userId;
    const userMessage = body.messages?.[body.messages.length - 1];
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
      body.interruptReason === "user_steered" ? body.interruptReason : undefined;
    this.logger.log(
      `agent run requested ${safeLogJson({
        conversationId,
        runId,
        userId,
        userMessageId: userMessage?.id,
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
    const runtimeType =
      workspaceRuntimeType ?? this.configService.getDefaultRuntimeType();
    if (!this.configService.isRuntimeTypeAllowed(runtimeType)) {
      throw new BadRequestException("当前部署不支持该工作空间的运行环境");
    }
    let isolationScope: IsolationScope | undefined;
    if (runtimeType === "sandbox") {
      const resolvedIsolationScope =
        workspaceIsolationScope ??
        this.configService.getDefaultIsolationScope();
      if (
        !this.configService.isIsolationScopeAllowed(
          resolvedIsolationScope
        )
      ) {
        throw new BadRequestException("当前部署不支持该工作空间的隔离级别");
      }
      isolationScope = resolvedIsolationScope;
    }

    const placement = this.runtimePlacementService.resolveForRun({
      userId,
      workspaceId,
      workspaceRootPath,
      userWorkspaceRootPath: this.configService.getUserWorkspace(userId),
      runtimeType,
      isolationScope,
      sandboxEngine: workspaceSandboxEngine ?? undefined,
    });

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

    // Build RunConfig for worker
    let runConfig;
    try {
      runConfig = await this.runConfigBuilder.buildRunConfig({
        agentType,
        modelProviderId,
        workspaceId,
        placement,
        runId,
        conversationId,
        input: runInput,
        model: requestedModel,
      });
    } catch (err) {
      throw new BadRequestException(
        err instanceof Error ? err.message : String(err)
      );
    }

    // Set up SSE response
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    if (conversationId) {
      // 尝试更新状态，使用乐观锁防止并发
      // setActiveRunStatus 内部会检查 activeRunStatus in ["idle", "error"] 才会更新为 running
      const result = await this.conversationService.setActiveRunStatus(
        conversationId,
        "running"
      );

      if (result.count === 0) {
        // 更新失败，查询当前状态以区分情况
        try {
          await this.conversationService.findOne(userId, conversationId);
          if (interruptReason === "user_steered") {
            await this.runtimeRunner.stop(conversationId, {
              reason: "user_steered",
              endResponse: true,
            });
            this.logger.log(
              `active run interrupted by user steering ${safeLogJson({
                conversationId,
                runId,
              })}`
            );
          } else {
            // conversation 存在但更新失败，说明状态为 running
            throw new ConflictException(
              "A run is already active for this conversation"
            );
          }
        } catch (err) {
          if (err instanceof ConflictException) throw err;
          // findOne 失败：conversation 不存在或数据库错误
          if (
            err instanceof Prisma.PrismaClientKnownRequestError &&
            err.code === "P2025"
          ) {
            throw new NotFoundException(
              `Conversation ${conversationId} not found`
            );
          }
          throw err;
        }
      }
    }

    if (conversationId && userMessage) {
      await this.conversationService.saveUserMessage(
        conversationId,
        userMessage
      );

      // 标题只依赖用户首条消息，发送即可生成，与助手回复并行
      this.titleService
        .maybeGenerate(conversationId, agentType, modelProviderId)
        .catch(
          swallow(
            this.logger,
            `generate title for conversation ${conversationId}`
          )
        );
    }

    // Set up aggregator and saveRun
    const aggregator = new RuntimeMessageAggregator();
    // 串行化 saveRun：chunk 节流 / 事件边界 / 终态会多次调用，原 fire-and-forget
    // 并发 upsert 可能乱序完成——较早的不完整快照若晚于终态完整快照落库，会把
    // status 覆盖回 incomplete。用 promise 链按调用顺序执行 build+upsert，
    // 保证终态写入最后落库。build 也在链中执行，确保终态取到含全部内容的快照。
    let saveChain: Promise<void> = Promise.resolve();
    const saveRun = (
      complete: boolean,
      incompleteReason?: IncompleteMessageReason
    ) => {
      if (!conversationId) return;
      saveChain = saveChain
        .then(() => {
          const snap = aggregator.build(complete, incompleteReason);
          if (snap.content.length === 0) return;
          const contentId = snap.messageId ?? runId;
          return this.conversationService.upsertMessage(conversationId, {
            id: runId,
            runId,
            parent_id: null,
            format: "assistant-ui",
            content: {
              role: "assistant",
              id: contentId,
              content: snap.content,
              status: snap.status,
              ...(snap.metadata ? { metadata: snap.metadata } : {}),
            },
          });
        })
        .catch((err: unknown) => {
          this.logger.warn(
            `persist assistant message for conversation ${conversationId}: ${err instanceof Error ? err.message : String(err)}`
          );
        });
    };

    // Delegate all run lifecycle operations to RuntimeRunner
    await this.runtimeRunner.start({
      runId,
      conversationId,
      agentType,
      placement,
      runConfig,
      res,
      aggregator,
      saveRun,
      onAgentSessionId: (sessionId) => {
        this.conversationService
          .setAgentSessionId(conversationId, sessionId)
          .catch(
            swallow(this.logger, `persist agent session for ${conversationId}`)
          );
      },
    });
  }

  /**
   * 刷新网页后续接进行中的 run：校验 conversation 归属后，把 SSE response
   * 交给 RuntimeRunner.attachStream 接到活跃 run 上。
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
    await this.runtimeRunner.attachStream(conversationId, res);
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
