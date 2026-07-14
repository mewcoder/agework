import {
  Injectable,
  Inject,
  Logger,
  BadRequestException,
  ConflictException,
} from "@nestjs/common";
import type { Response } from "express";
import {
  parseOwnerKey,
  userOwnerKey,
  workspaceOwnerKey,
  type AgentProviderConfig,
  type RecordRunEventInput,
  type RunPlacement,
  type RuntimeHostExecution,
  type RunExecutionHandle,
  type WorkerScope,
} from "@agework/shared/protocol";
import { isRuntimeType } from "@agework/providers";
import { RunRepository } from "../run.repository";
import { LiveRunRegistry } from "../live-run/live-run.registry";
import { RUNTIME_HOST_EXECUTION } from "../../host-dispatch/host-dispatch.types";
import { ConversationService } from "../../conversation/conversation.service";
import {
  AssistantMessageAggregator,
  type IncompleteMessageReason,
} from "../upstream/assistant-message.aggregator";
import { ConfigService } from "../../config/config.service";
import { swallow } from "../../common/swallow";
import { errorLogFields } from "../../common/logging";
import { RunEventService } from "../../run-event/run-event.service";
import type { StartRunInput } from "../run.types";
import type { WorkspaceRunContext } from "../../workspace/workspace.types";
import { RunStream } from "../streaming/run.stream";

type SaveRun = (
  complete: boolean,
  incompleteReason?: IncompleteMessageReason
) => void;

/**
 * 已有活跃 run 时如何让位：claimRun 在 user_steered 场景需要先停掉旧 run。
 * 由 RunService 注入实现，避免 RunLauncher 反向依赖 RunService 形成环。
 */
export type StopActiveRun = (
  conversationId: string,
  options?: { reason?: IncompleteMessageReason; endResponse?: boolean }
) => Promise<boolean>;

/**
 * 一次 run 的启动准备能力：业务放置校验、并发守卫、落库 run 记录、提交执行面
 * （RuntimeHostContract.submitRun）、注册 live handle。从 RunService 抽出的稳定
 * 子能力，只在 run 模块内部使用。RunConfig 组装、CLI 路径、日志路径等执行机细节
 * 归 Host 侧（契约实现），run 层从此看不见 worker/RunConfig。
 */
@Injectable()
export class RunLauncher {
  private readonly logger = new Logger(RunLauncher.name);

  constructor(
    private readonly runRepository: RunRepository,
    private readonly liveRuns: LiveRunRegistry,
    @Inject(RUNTIME_HOST_EXECUTION)
    private readonly runtimeHost: RuntimeHostExecution,
    private readonly conversationService: ConversationService,
    private readonly runEvents: RunEventService,
    private readonly configService: ConfigService
  ) {}

  /** 启动一次 run：从 placement 解析到 live handle 注册的完整出站准备链路。 */
  async launch(
    input: StartRunInput,
    ports: { stopActiveRun: StopActiveRun }
  ): Promise<void> {
    const {
      runId,
      conversationId,
      userId,
      agentProviderConfig,
      modelProviderId,
      workspace,
      input: runInput,
      userMessage,
      userMessageId,
      res,
      interruptReason,
    } = input;
    const agentType = agentProviderConfig.agentType;
    const placement = this.buildPlacement({ workspace, userId });
    const runtimeType = placement.runtimeType;
    const scope = parseOwnerKey(placement.owner).scope;
    const stream = new RunStream(res);

    await this.claimRun({
      conversationId,
      userId,
      runId,
      interruptReason,
      stopActiveRun: ports.stopActiveRun,
    });
    await this.saveUserTurn({
      conversationId,
      userMessage,
      agentType,
      modelProviderId,
    });

    const aggregator = new AssistantMessageAggregator();
    const saveRun = this.makeSaveRun({ conversationId, runId, aggregator });
    const onAgentSessionId = this.saveSession(conversationId);

    this.logger.log("run starting", {
      runId,
      conversationId,
      workspaceId: placement.workspaceId,
      agentType,
      runtimeType,
      scope,
    });

    const runCreated = await this.createRun({
      runId,
      conversationId,
      workspaceId: placement.workspaceId,
      agentType,
      runtimeType,
      scope,
      userMessageId,
      userId,
      stream,
    });
    if (!runCreated) return;

    const runtimeHandle: RunExecutionHandle = {
      runId,
      runtimeHostId: placement.runtimeHostId,
      runtimeType,
      conversationId,
    };
    this.registerRun({
      runId,
      conversationId,
      workspaceId: placement.workspaceId,
      runtimeHandle,
      stream,
      aggregator,
      agentType,
      saveRun,
      onAgentSessionId,
      res,
    });

    const submitted = await this.submitToHost({
      runId,
      conversationId,
      placement,
      agentProviderConfig,
      runInput,
      stream,
    });
    if (!submitted) this.liveRuns.unregister(runId);
  }

  /**
   * 业务放置校验 + 构造 RunPlacement。部署 allow-list 是 builtin Host 的策略，
   * registered Host 的 workspace 跳过——它的 runtimeType/scope 已在
   * 创建时对着该 Host 的能力矩阵校验过(见
   * WorkspaceService.resolveRegisteredPlacement)。执行机路径/RunConfig 派生
   * 不在这里:那是 Host 侧(契约实现)的职责。
   */
  private buildPlacement(input: {
    workspace: WorkspaceRunContext;
    userId: string;
  }): RunPlacement {
    const { workspace, userId } = input;
    const registered = workspace.runtimeSource === "registered";
    const runtimeType = workspace.runtimeType;
    if (!registered && !this.configService.isRuntimeTypeAllowed(runtimeType)) {
      throw new BadRequestException("当前部署不支持该工作空间的运行环境");
    }
    if (!isRuntimeType(runtimeType)) {
      throw new BadRequestException(
        `工作空间的运行环境类型无效: ${runtimeType}`
      );
    }

    const requestedWorkerScope = workspace.scope;
    if (
      requestedWorkerScope !== "user" &&
      requestedWorkerScope !== "workspace"
    ) {
      throw new BadRequestException(
        `工作空间的运行范围无效: ${requestedWorkerScope}`
      );
    }
    if (runtimeType === "native" && requestedWorkerScope !== "workspace") {
      throw new BadRequestException("native 运行方式只支持 workspace 范围");
    }
    if (
      runtimeType !== "native" &&
      !registered &&
      !this.configService.isWorkerScopeAllowed(requestedWorkerScope)
    ) {
      throw new BadRequestException("当前部署不支持该工作空间的运行范围");
    }
    const scope: WorkerScope = requestedWorkerScope;

    return {
      owner:
        scope === "user"
          ? userOwnerKey(userId)
          : workspaceOwnerKey(workspace.workspaceId),
      runtimeType,
      runtimeHostId: workspace.runtimeHostId,
      workspaceId: workspace.workspaceId,
      userId,
      username: workspace.username,
      workspacePath: workspace.workspaceRootPath,
    };
  }

  private async claimRun(input: {
    conversationId: string;
    userId: string;
    runId: string;
    interruptReason?: "user_steered";
    stopActiveRun: StopActiveRun;
  }): Promise<void> {
    const { conversationId, userId, runId, interruptReason, stopActiveRun } =
      input;
    const activated = await this.conversationService.activateConversation(
      conversationId,
      userId
    );
    if (activated) return;
    if (interruptReason === "user_steered") {
      await stopActiveRun(conversationId, {
        reason: "user_steered",
        endResponse: true,
      });
      this.logger.log("active run interrupted by user steering", {
        conversationId,
        runId,
      });
      return;
    }

    throw new ConflictException(
      "A run is already active for this conversation"
    );
  }

  private async saveUserTurn(input: {
    conversationId: string;
    userMessage: StartRunInput["userMessage"];
    agentType: AgentProviderConfig["agentType"];
    modelProviderId: string;
  }): Promise<void> {
    const { conversationId, userMessage, agentType, modelProviderId } = input;
    if (!userMessage) return;

    await this.conversationService.saveUserMessage(
      conversationId,
      userMessage,
      {
        agentType,
        modelProviderId,
      }
    );
  }

  private makeSaveRun(input: {
    conversationId: string;
    runId: string;
    aggregator: AssistantMessageAggregator;
  }): SaveRun {
    const { conversationId, runId, aggregator } = input;
    let saveChain: Promise<void> = Promise.resolve();

    return (complete, incompleteReason) => {
      saveChain = saveChain
        .then(() =>
          // 信封形状归 conversation 领域,这里只交快照本体。
          this.conversationService.saveAssistantMessage(
            conversationId,
            runId,
            aggregator.build(complete, incompleteReason)
          )
        )
        .catch((err: unknown) => {
          this.logger.warn(
            `persist assistant message for conversation ${conversationId}: ${err instanceof Error ? err.message : String(err)}`
          );
        });
    };
  }

  private saveSession(conversationId: string): (sessionId: string) => void {
    return (sessionId) => {
      this.conversationService
        .setAgentSessionId(conversationId, sessionId)
        .catch(
          swallow(this.logger, `persist agent session for ${conversationId}`)
        );
    };
  }

  private async createRun(input: {
    runId: string;
    conversationId: string;
    workspaceId: string;
    agentType: string;
    runtimeType: string;
    scope: string;
    userMessageId?: string;
    userId: string;
    stream: RunStream;
  }): Promise<boolean> {
    const {
      runId,
      conversationId,
      workspaceId,
      agentType,
      runtimeType,
      scope,
      userMessageId,
      userId,
      stream,
    } = input;

    try {
      await this.runRepository.create({
        id: runId,
        conversationId,
        agentType,
        runtimeType,
      });
      this.recordRunEvent(
        this.runEvents.runCreated({
          runId,
          conversationId,
          workspaceId,
          agentType,
          runtimeType,
          scope,
        }),
        `record run created for run ${runId}`
      );
      if (userMessageId) {
        await this.conversationService
          .attachMessageToRun(conversationId, userMessageId, runId)
          .catch(
            swallow(
              this.logger,
              `attach user message ${userMessageId} to run ${runId}`
            )
          );
        this.recordRunEvent(
          this.runEvents.messageAccepted({
            runId,
            conversationId,
            messageId: userMessageId,
            userId,
          }),
          `record message accepted for run ${runId}`
        );
      }
      return true;
    } catch (err) {
      this.logger.warn("create run record failed", {
        runId,
        conversationId,
        ...errorLogFields(err),
      });
      const errorMsg = err instanceof Error ? err.message : String(err);
      stream.writeError({ threadId: conversationId, runId, message: errorMsg });
      stream.end();
      return false;
    }
  }

  /**
   * 把 run 提交给执行面（受理即返回，就绪/失败经上行事件流回流）。
   * 受理失败（组装/配置问题在 submitRun 内同步暴露）按启动失败收尾。
   */
  private async submitToHost(input: {
    runId: string;
    conversationId: string;
    placement: RunPlacement;
    agentProviderConfig: AgentProviderConfig;
    runInput: unknown;
    stream: RunStream;
  }): Promise<boolean> {
    const {
      runId,
      conversationId,
      placement,
      agentProviderConfig,
      runInput,
      stream,
    } = input;
    const runtimeType = placement.runtimeType;

    try {
      this.recordRunEvent(
        this.runEvents.runtimeStatusChanged({
          runId,
          status: "starting",
          runtimeType,
          scope: parseOwnerKey(placement.owner).scope,
        }),
        `record runtime starting for run ${runId}`
      );
      await this.runtimeHost.submitRun({
        runId,
        conversationId,
        placement,
        agentProviderConfig,
        input: runInput,
      });
      return true;
    } catch (err) {
      this.logger.error("start worker failed", {
        runId,
        conversationId,
        runtimeType,
        ...errorLogFields(err),
      });
      await this.runRepository
        .markError(runId, "Failed to start worker")
        .catch(swallow(this.logger, `mark run ${runId} start failure`));
      this.runEvents
        .append(
          this.runEvents.runtimeStatusChanged({
            runId,
            status: "start_failed",
            runtimeType,
            scope: parseOwnerKey(placement.owner).scope,
            error: err instanceof Error ? err.message : String(err),
            data: errorLogFields(err),
          })
        )
        .catch(
          swallow(this.logger, `record runtime start failure for run ${runId}`)
        )
        .finally(() => this.runEvents.forgetRun(runId));
      await this.conversationService
        .setConversationRunState(conversationId, { runStatus: "error" })
        .catch(
          swallow(
            this.logger,
            `set conversation active run status to error for run ${runId}`
          )
        );
      const errorMsg = err instanceof Error ? err.message : String(err);
      stream.writeError({
        threadId: conversationId,
        runId,
        message: "启动 worker 失败: " + errorMsg,
      });
      stream.end();
      return false;
    }
  }

  /** best-effort 记录一条 run 事件:失败只打日志,不影响启动链路。 */
  private recordRunEvent(event: RecordRunEventInput, context: string): void {
    this.runEvents.append(event).catch(swallow(this.logger, context));
  }

  private registerRun(input: {
    runId: string;
    conversationId: string;
    workspaceId: string;
    runtimeHandle: RunExecutionHandle;
    stream: RunStream;
    aggregator: AssistantMessageAggregator;
    agentType: string;
    saveRun: SaveRun;
    onAgentSessionId: (sessionId: string) => void;
    res: Response;
  }): void {
    const {
      runId,
      conversationId,
      workspaceId,
      runtimeHandle,
      stream,
      aggregator,
      agentType,
      saveRun,
      onAgentSessionId,
      res,
    } = input;

    this.liveRuns.register(runId, {
      runtimeHandle,
      stream,
      aggregator,
      conversationId,
      runId,
      workspaceId,
      agentType,
      stopRequested: false,
      saveRun,
      onAgentSessionId,
    });

    // SSE disconnect: detach the response (don't cancel the run)
    stream.onClose(() => {
      const handle = this.liveRuns.get(runId);
      if (handle) {
        handle.stream.detach(res);
      }
    });

    this.logger.log("run registered", {
      runId,
      conversationId,
      runtimeHostId: runtimeHandle.runtimeHostId,
      runtimeType: runtimeHandle.runtimeType,
    });
  }
}
