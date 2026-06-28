import {
  Injectable,
  Logger,
  BadRequestException,
  ConflictException,
} from "@nestjs/common";
import { join, posix } from "node:path";
import type { Response } from "express";
import type {
  AgentProviderConfig,
  RunConfig,
  RuntimePlacement,
  RuntimeTarget,
  WorkerExecutionHandle,
} from "@agework/shared/protocol";
import { RunRepository } from "../run.repository";
import { LiveRunRegistry } from "../live-run/live-run.registry";
import { RuntimeService } from "../../runtime/runtime.service";
import { ExecutionService } from "../execution/execution.service";
import { RunConversationEffects } from "../conversation/run-conversation.effects";
import {
  AssistantMessageAggregator,
  type IncompleteMessageReason,
} from "../worker-event/assistant-message.aggregator";
import { ConfigService, type IsolationScope } from "../../config/config.service";
import { CONTAINER_RUNTIME_LOG_DIR } from "../../config/registry/defaults";
import { swallow } from "../../common/swallow";
import { errorLogFields, safeLogJson } from "../../common/logging";
import { RunEventService, compactData } from "../../run-event/run-event.service";
import type { StartRunInput, RunWorkspaceView } from "../run-service.types";
import { safePathPart } from "../../common/safe-path";
import { RunStream } from "../streaming/run-stream";

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
 * 一次 run 的启动准备能力：解析 placement、组装 RunConfig、并发守卫、落库 run 记录、
 * 拉起 worker、注册 live handle。从 RunService 抽出的稳定子能力，只在 run 模块内部使用。
 * RunService.start 仅按顺序委托到本 provider，不持有这些组装/持久化细节。
 */
@Injectable()
export class RunLauncher {
  private readonly logger = new Logger(RunLauncher.name);

  constructor(
    private readonly runRepository: RunRepository,
    private readonly liveRuns: LiveRunRegistry,
    private readonly runtimeService: RuntimeService,
    private readonly executionService: ExecutionService,
    private readonly runConversation: RunConversationEffects,
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
    const runtimeTarget = this.getPlacement({ workspace, userId });
    const placement = runtimeTarget;
    const runtimeType = placement.runtimeType;
    const sandbox =
      placement.runtimeType === "sandbox" ? placement.sandbox : undefined;
    const runConfig = this.makeRunConfig({
      agentProviderConfig,
      placement,
      workspaceId: workspace.workspaceId,
      runId,
      conversationId,
      input: runInput,
    });
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

    this.logger.log(
      `run starting ${safeLogJson({
        runId,
        conversationId,
        workspaceId: placement.workspaceId,
        agentType,
        runtimeType,
        isolationScope: sandbox?.isolationScope,
      })}`
    );

    const runCreated = await this.createRun({
      runId,
      conversationId,
      workspaceId: placement.workspaceId,
      agentType,
      runtimeType,
      isolationScope: sandbox?.isolationScope,
      userMessageId,
      userId,
      stream,
    });
    if (!runCreated) return;

    const runtimeHandle = await this.startWorker({
      runId,
      conversationId,
      runtimeType,
      isolationScope: sandbox?.isolationScope,
      sandboxEngineType: sandbox?.sandboxEngineType,
      runConfig,
      runtimeTarget,
      stream,
    });
    if (!runtimeHandle) return;

    await this.saveRuntime(runId, runtimeHandle);
    this.registerRun({
      runId,
      conversationId,
      runtimeHandle,
      stream,
      aggregator,
      runConfig,
      agentType,
      saveRun,
      onAgentSessionId,
      res,
    });
  }

  private getPlacement(input: {
    workspace: RunWorkspaceView;
    userId: string;
  }): RuntimeTarget {
    const { workspace, userId } = input;
    const requestedRuntimeType =
      workspace.runtimeType ?? this.configService.getDefaultRuntimeType();
    if (!this.configService.isRuntimeTypeAllowed(requestedRuntimeType)) {
      throw new BadRequestException("当前部署不支持该工作空间的运行环境");
    }
    let isolationScope: IsolationScope | undefined;
    if (requestedRuntimeType === "sandbox") {
      const resolvedIsolationScope =
        workspace.isolationScope ??
        this.configService.getDefaultIsolationScope();
      if (!this.configService.isIsolationScopeAllowed(resolvedIsolationScope)) {
        throw new BadRequestException("当前部署不支持该工作空间的隔离级别");
      }
      isolationScope = resolvedIsolationScope;
    }

    return this.runtimeService.resolveRuntimeTarget({
      userId,
      workspaceId: workspace.workspaceId,
      workspaceRootPath: workspace.workspaceRootPath,
      userWorkspaceRootPath: this.configService.getUserWorkspace(
        workspace.username
      ),
      runtimeType: requestedRuntimeType,
      isolationScope,
      sandboxEngine:
        (workspace.sandboxEngine as "docker" | "opensandbox") ?? undefined,
    });
  }

  private makeRunConfig(params: {
    agentProviderConfig: AgentProviderConfig;
    placement: RuntimePlacement;
    workspaceId: string;
    runId: string;
    conversationId: string;
    input: unknown;
  }): RunConfig {
    const {
      agentProviderConfig,
      placement,
      workspaceId,
      runId,
      conversationId,
      input,
    } = params;
    try {
      const logPaths = this.makeLogPaths(placement, conversationId);

      return {
        runId,
        conversationId,
        workspaceId,
        runtimePath: placement.runtimePath,
        env: {},
        input,
        agentProviderConfig,
        agentEventTrace: buildAgentEventTraceConfig({
          ...this.configService.getAgentEventTraceConfig(),
          runId,
          conversationId,
          workspaceId,
          agentType: agentProviderConfig.agentType,
          ...logPaths,
        }),
        workerLogFilePath: logPaths.workerRuntimeFilePath,
      };
    } catch (err) {
      throw new BadRequestException(
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  private makeLogPaths(
    placement: RuntimePlacement,
    conversationId: string
  ): RuntimeLogPaths {
    const logDir = this.configService.getRuntimeLogDir();
    const conversationFileName = safePathPart(conversationId);
    const rawFileName = `${conversationFileName}.raw.jsonl`;
    const aguiFileName = `${conversationFileName}.agui.jsonl`;
    const workerFileName = `${conversationFileName}.worker.log`;
    const isSandbox = placement.runtimeType === "sandbox";

    return {
      logDir,
      rawFilePath: join(logDir, rawFileName),
      rawRuntimeFilePath: isSandbox
        ? posix.join(CONTAINER_RUNTIME_LOG_DIR, rawFileName)
        : join(logDir, rawFileName),
      aguiFilePath: join(logDir, aguiFileName),
      aguiRuntimeFilePath: isSandbox
        ? posix.join(CONTAINER_RUNTIME_LOG_DIR, aguiFileName)
        : join(logDir, aguiFileName),
      workerRuntimeFilePath: isSandbox
        ? posix.join(CONTAINER_RUNTIME_LOG_DIR, workerFileName)
        : join(logDir, workerFileName),
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
    const activated = await this.runConversation.markRunning(conversationId);
    if (activated) return;

    try {
      await this.runConversation.assertOwned(userId, conversationId);
      if (interruptReason === "user_steered") {
        await stopActiveRun(conversationId, {
          reason: "user_steered",
          endResponse: true,
        });
        this.logger.log(
          `active run interrupted by user steering ${safeLogJson({
            conversationId,
            runId,
          })}`
        );
        return;
      }

      throw new ConflictException(
        "A run is already active for this conversation"
      );
    } catch (err) {
      if (err instanceof ConflictException) throw err;
      throw err;
    }
  }

  private async saveUserTurn(input: {
    conversationId: string;
    userMessage: StartRunInput["userMessage"];
    agentType: AgentProviderConfig["agentType"];
    modelProviderId: string;
  }): Promise<void> {
    const { conversationId, userMessage, agentType, modelProviderId } = input;
    if (!userMessage) return;

    await this.runConversation.saveUserMessage(conversationId, userMessage);
    this.runConversation
      .generateTitleIfNeeded({ conversationId, agentType, modelProviderId })
      .catch(
        swallow(
          this.logger,
          `generate title for conversation ${conversationId}`
        )
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
        .then(() => {
          const snap = aggregator.build(complete, incompleteReason);
          if (snap.content.length === 0) return;
          const contentId = snap.messageId ?? runId;
          return this.runConversation.upsertMessage(conversationId, {
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
  }

  private saveSession(conversationId: string): (sessionId: string) => void {
    return (sessionId) => {
      this.runConversation
        .saveAgentSessionId(conversationId, sessionId)
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
    isolationScope?: string;
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
      isolationScope,
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
      this.runEvents
        .append(
          this.runEvents.runCreated({
            runId,
            conversationId,
            workspaceId,
            agentType,
            runtimeType,
            isolationScope,
          })
        )
        .catch(swallow(this.logger, `record run created for run ${runId}`));
      if (userMessageId) {
        await this.runConversation
          .attachMessageToRun(conversationId, userMessageId, runId)
          .catch(
            swallow(
              this.logger,
              `attach user message ${userMessageId} to run ${runId}`
            )
          );
        this.runEvents
          .append(
            this.runEvents.messageAccepted({
              runId,
              conversationId,
              messageId: userMessageId,
              userId,
            })
          )
          .catch(
            swallow(this.logger, `record message accepted for run ${runId}`)
          );
      }
      return true;
    } catch (err) {
      this.logger.warn(
        `create run record failed ${safeLogJson({
          runId,
          conversationId,
          ...errorLogFields(err),
        })}`
      );
      const errorMsg = err instanceof Error ? err.message : String(err);
      stream.writeError({ threadId: conversationId, runId, message: errorMsg });
      stream.end();
      return false;
    }
  }

  private async startWorker(input: {
    runId: string;
    conversationId: string;
    runtimeType: string;
    isolationScope?: string;
    sandboxEngineType?: string;
    runConfig: RunConfig;
    runtimeTarget: RuntimeTarget;
    stream: RunStream;
  }): Promise<WorkerExecutionHandle | null> {
    const {
      runId,
      conversationId,
      runtimeType,
      isolationScope,
      sandboxEngineType,
      runConfig,
      runtimeTarget,
      stream,
    } = input;

    try {
      this.runEvents
        .append(
          this.runEvents.runtimeStatusChanged({
            runId,
            status: "starting",
            runtimeType,
            isolationScope,
            sandboxEngineType,
          })
        )
        .catch(
          swallow(this.logger, `record runtime starting for run ${runId}`)
        );
      return this.executionService.start({
        runConfig,
        runtimeTarget,
        onRuntimeInstanceIdReady: (runtimeInstanceId) => {
          this.runRepository
            .updateRuntimeHandle(runId, runtimeType, runtimeInstanceId)
            .catch(
              swallow(this.logger, `persist runtime handle for run ${runId}`)
            );
          this.runEvents
            .append(
              this.runEvents.runtimeStatusChanged({
                runId,
                eventKey: `runtime:${runtimeInstanceId}:ready`,
                status: "ready",
                targetId: runtimeInstanceId,
                runtimeType,
                runtimeInstanceId,
              })
            )
            .catch(
              swallow(this.logger, `record runtime ready for run ${runId}`)
            );
        },
      });
    } catch (err) {
      this.logger.error(
        `start worker failed ${safeLogJson({
          runId,
          conversationId,
          runtimeType,
          ...errorLogFields(err),
        })}`
      );
      await this.runRepository
        .markError(runId, "Failed to start worker")
        .catch(swallow(this.logger, `mark run ${runId} start failure`));
      this.runEvents
        .append(
          this.runEvents.runtimeStatusChanged({
            runId,
            status: "start_failed",
            error: err instanceof Error ? err.message : String(err),
            data: compactData(errorLogFields(err)),
          })
        )
        .catch(
          swallow(this.logger, `record runtime start failure for run ${runId}`)
        )
        .finally(() => this.runEvents.forgetRun(runId));
      await this.runConversation
        .markError(conversationId)
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
      return null;
    }
  }

  private async saveRuntime(
    runId: string,
    runtimeHandle: WorkerExecutionHandle
  ): Promise<void> {
    if (runtimeHandle.runtimeInstanceId) {
      await this.runRepository
        .updateRuntimeHandle(
          runId,
          runtimeHandle.runtimeType,
          runtimeHandle.runtimeInstanceId
        )
        .catch(swallow(this.logger, `persist runtime handle for run ${runId}`));
      this.runEvents
        .append(
          this.runEvents.runtimeStatusChanged({
            runId,
            eventKey: `runtime:${runtimeHandle.runtimeInstanceId}:ready`,
            status: "ready",
            targetId: runtimeHandle.runtimeInstanceId,
            runtimeType: runtimeHandle.runtimeType,
            runtimeInstanceId: runtimeHandle.runtimeInstanceId,
          })
        )
        .catch(swallow(this.logger, `record runtime ready for run ${runId}`));
    }
  }

  private registerRun(input: {
    runId: string;
    conversationId: string;
    runtimeHandle: WorkerExecutionHandle;
    stream: RunStream;
    aggregator: AssistantMessageAggregator;
    runConfig: RunConfig;
    agentType: string;
    saveRun: SaveRun;
    onAgentSessionId: (sessionId: string) => void;
    res: Response;
  }): void {
    const {
      runId,
      conversationId,
      runtimeHandle,
      stream,
      aggregator,
      runConfig,
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
      workspaceId: runConfig.workspaceId,
      agentType,
      agentEventTrace: runConfig.agentEventTrace,
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

    this.logger.log(
      `run registered ${safeLogJson({
        runId,
        conversationId,
        runtimeType: runtimeHandle.runtimeType,
        runtimeInstanceId: runtimeHandle.runtimeInstanceId,
      })}`
    );
  }
}

type RuntimeLogPaths = {
  logDir: string;
  rawFilePath: string;
  rawRuntimeFilePath: string;
  aguiFilePath: string;
  aguiRuntimeFilePath: string;
  workerRuntimeFilePath: string;
};

// enabled 只控制 raw/agui 大 payload 是否落 JSONL 文件（"trace" 这里指完整证据，不是事件索引）。
// DB 关键事件索引（RunEventService 写入的 RunEvent）与本开关无关，始终记录，关闭本开关后 run
// 仍可在管理端看到事件摘要，只是看不到完整 raw/agui payload 原文。开关与上限由 ConfigService 提供。
function buildAgentEventTraceConfig(input: {
  enabled: boolean;
  maxFileMb: number;
  runId: string;
  conversationId: string;
  workspaceId: string;
  agentType: string;
  logDir: string;
  rawFilePath: string;
  rawRuntimeFilePath: string;
  aguiFilePath: string;
  aguiRuntimeFilePath: string;
}) {
  const { enabled } = input;
  return {
    enabled,
    logDir: enabled ? input.logDir : undefined,
    rawFilePath: enabled ? input.rawFilePath : undefined,
    rawRuntimeFilePath: enabled ? input.rawRuntimeFilePath : undefined,
    aguiFilePath: enabled ? input.aguiFilePath : undefined,
    aguiRuntimeFilePath: enabled ? input.aguiRuntimeFilePath : undefined,
    maxFileMb: input.maxFileMb,
    runId: input.runId,
    conversationId: input.conversationId,
    workspaceId: input.workspaceId,
    agentType: input.agentType,
  };
}
