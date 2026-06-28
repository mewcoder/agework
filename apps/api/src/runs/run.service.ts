import {
  Injectable,
  Logger,
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { join, posix } from "node:path";
import { generateId } from "@agework/shared";
import type { Response } from "express";
import type {
  AgentProviderConfig,
  RunConfig,
  RuntimePlacement,
  RuntimeTarget,
  WorkerExecutionHandle,
} from "@agework/shared/protocol";
import { Prisma } from "../../generated/prisma/client.js";
import { RunRepository } from "./run.repository";
import { LiveRunRegistry } from "./live-runs/live-run.registry";
import { RuntimeService } from "../runtime/runtime.service";
import { ExecutionService } from "./execution/execution.service";
import { ConversationService } from "../conversations/conversation.service";
import { RunConversationEffects } from "./conversation/run-conversation.effects";
import {
  AssistantMessageAggregator,
  type IncompleteMessageReason,
} from "./worker-events/assistant-message.aggregator";
import { ConfigService, type IsolationScope } from "../config/config.service";
import { CONTAINER_RUNTIME_LOG_DIR } from "../config/registry/defaults";
import { EnvKey } from "../config/registry/env-key";
import { swallow } from "../common/swallow";
import { errorLogFields, safeLogJson } from "../common/logging";
import { RunEventService, compactData } from "../run-events/run-event.service";
import type { StartRunInput } from "./run-service.types";
import { safePathPart } from "../common/safe-path";
import { RunStream } from "./streaming/run-stream";

const DEFAULT_AGENT_EVENT_TRACE_MAX_FILE_MB = 50;

type RunWorkspace = {
  workspaceId: string;
  workspaceRootPath: string;
  runtimeType?: string;
  isolationScope?: string | null;
  sandboxEngine?: string | null;
  username: string;
};

type SaveRun = (
  complete: boolean,
  incompleteReason?: IncompleteMessageReason
) => void;

@Injectable()
export class RunService {
  private readonly logger = new Logger(RunService.name);

  constructor(
    private readonly runRepository: RunRepository,
    private readonly liveRuns: LiveRunRegistry,
    private readonly runtimeService: RuntimeService,
    private readonly executionService: ExecutionService,
    private readonly conversationService: ConversationService,
    private readonly runConversation: RunConversationEffects,
    private readonly runEvents: RunEventService,
    private readonly configService: ConfigService
  ) {}

  /** 管理端：分页查询 run 列表。 */
  listAdminRuns(params: { status?: string; take: number; skip: number }) {
    return this.runRepository.listAdmin(params);
  }

  /** 管理端：单个 run 详情。 */
  getAdminRunDetail(id: string) {
    return this.runRepository.detailAdmin(id);
  }

  /** 管理端：按 run 查询事件（编排 run-events 的读路径）。 */
  listAdminRunEvents(
    params: Parameters<RunEventService["listAdminEvents"]>[0]
  ) {
    return this.runEvents.listAdminEvents(params);
  }

  /** workspace 删除前的活跃任务守卫：该 workspace 是否有正在进行的 run。 */
  hasActiveRunForWorkspace(workspaceId: string) {
    return this.runRepository.hasActiveRunForWorkspace(workspaceId);
  }

  async start(input: StartRunInput): Promise<void> {
    const {
      runId,
      conversationId,
      userId,
      agentProviderConfig,
      modelProviderId,
      workspaceId,
      input: runInput,
      userMessage,
      userMessageId,
      res,
      interruptReason,
    } = input;
    const agentType = agentProviderConfig.agentType;
    const workspace = await this.getWorkspace(workspaceId);
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

    await this.claimRun({ conversationId, userId, runId, interruptReason });
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

  private async getWorkspace(workspaceId: string): Promise<RunWorkspace> {
    const workspace = await this.runRepository.findWorkspaceForRun(workspaceId);
    if (!workspace) {
      throw new NotFoundException(`Workspace ${workspaceId} not found`);
    }
    if (!workspace.directory?.rootPath) {
      throw new BadRequestException("工作空间必须关联目录才能运行 agent");
    }
    return {
      workspaceId: workspace.id,
      workspaceRootPath: workspace.directory.rootPath,
      runtimeType: workspace.runtimeType ?? undefined,
      isolationScope: workspace.isolationScope,
      sandboxEngine: workspace.sandboxEngine,
      username: workspace.user.username,
    };
  }

  private getPlacement(input: {
    workspace: RunWorkspace;
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
  }): Promise<void> {
    const { conversationId, userId, runId, interruptReason } = input;
    const activated = await this.runConversation.markRunning(conversationId);
    if (activated) return;

    try {
      await this.conversationService.findOne(userId, conversationId);
      if (interruptReason === "user_steered") {
        await this.stop(conversationId, {
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
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2025"
      ) {
        throw new NotFoundException(`Conversation ${conversationId} not found`);
      }
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

    await this.conversationService.saveUserMessage(conversationId, userMessage);
    this.conversationService
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
        await this.conversationService
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

  async resolveApproval(
    conversationId: string,
    answers: Record<string, string | string[]>
  ): Promise<void> {
    const activeRun =
      await this.runRepository.findActiveByConversationId(conversationId);
    const handle = activeRun ? this.liveRuns.get(activeRun.id) : undefined;
    if (!handle) {
      throw new NotFoundException(
        `No active run for conversation: ${conversationId}`
      );
    }
    this.executionService.sendCommand(handle.runtimeHandle, {
      type: "approval_resolved",
      commandId: generateId(),
      conversationId,
      answers: answers ?? {},
    });
  }

  /**
   * 刷新网页后续接一个进行中的 run：把新的 SSE response 接到活跃 run 的 handle 上，
   * 以「累积快照」模式推送。前端 ThreadHistoryAdapter.resume
   * 直接 yield 这些快照，实现刷新后实时续接。
   *
   * 处理三种情况：
   *  - 活跃 run 且 status=running：补发当前累积快照，替换 res，后续事件转快照推送。
   *  - 活跃 run 但 status=requires_action：首版不接 stream，返回 409 让前端走正常 load+审批。
   *  - 无活跃 run / 无内存 handle（已结束）：发一个终态 complete 快照并 end，
   *    让前端 resume 流正常收尾，不卡在 running。
   */
  async resumeStream(conversationId: string, res: Response): Promise<void> {
    const activeRunRecord =
      await this.runRepository.findActiveByConversationId(conversationId);
    const handle = activeRunRecord
      ? this.liveRuns.get(activeRunRecord.id)
      : undefined;

    // run 已结束 / 无内存 handle：发终态快照收尾
    if (!handle) {
      const stream = new RunStream(res);
      stream.writeSnapshot({
        content: [],
        status: { type: "complete", reason: "unknown" },
      });
      stream.end();
      return;
    }

    // 等待审批的 run 首版不续接 stream（前端走正常 load 显示历史 + 审批 UI）
    if (activeRunRecord?.status === "requires_action") {
      const stream = new RunStream(res);
      stream.setStatus(409);
      stream.end();
      return;
    }

    // 接管 SSE 连接：原连接（刷新前）已断，单订阅直接替换
    // 守卫：若旧连接尚未关闭（close 事件未触发的 race condition），主动 end 防连接泄漏
    handle.stream.replace(res, "snapshots");

    // 补发当前累积快照（resume 流的起点，含已输出的全部内容）
    const initial = handle.aggregator.build(false, "streaming");
    handle.stream.writeSnapshot(this.toRunResult(initial));

    handle.stream.onClose(() => {
      // 连接断开只清引用，不取消 run（与正常 run 的 res.on close 一致）
      const current = this.liveRuns.get(handle.runId);
      if (current?.stream.isAttachedTo(res)) {
        current.stream.detach(res);
      }
    });
  }

  private toRunResult(snap: {
    content: unknown[];
    status: unknown;
    metadata?: Record<string, unknown>;
  }): { content: unknown[]; status: unknown; metadata?: unknown } {
    return {
      content: snap.content,
      status: snap.status,
      ...(snap.metadata ? { metadata: snap.metadata } : {}),
    };
  }

  /**
   * 停止指定 conversation 的活跃 run。
   * @returns 是否存在活跃的 in-memory run handle。
   *   AgentController 用此判断是否需要重置 conversation status。
   */
  async stop(
    conversationId: string,
    options?: { reason?: IncompleteMessageReason; endResponse?: boolean }
  ): Promise<boolean> {
    const activeRunRecord =
      await this.runRepository.findActiveByConversationId(conversationId);
    const handle = activeRunRecord
      ? this.liveRuns.get(activeRunRecord.id)
      : undefined;
    if (!handle) {
      // No in-memory handle — clean up stale state
      if (activeRunRecord) {
        await this.runRepository.markCancelled(activeRunRecord.id);
        this.runEvents
          .append(
            this.runEvents.runStatusChanged({
              runId: activeRunRecord.id,
              origin: "platform",
              status: "cancelled",
              reason: "cancelled_without_handle",
            })
          )
          .catch(
            swallow(
              this.logger,
              `record cancel without handle for run ${activeRunRecord.id}`
            )
          );
      }
      return false;
    }
    handle.stopRequested = true;
    handle.stopReason = options?.reason;
    if (activeRunRecord) {
      await this.runRepository.markCancelling(activeRunRecord.id);
      this.runEvents
        .append(
          this.runEvents.runStatusChanged({
            runId: activeRunRecord.id,
            origin: "platform",
            status: "cancelling",
            reason: options?.reason,
          })
        )
        .catch(
          swallow(
            this.logger,
            `record cancel request for run ${activeRunRecord.id}`
          )
        );
    }
    this.executionService.cancel(handle.runtimeHandle);
    if (options?.endResponse) {
      handle.saveRun(false, options.reason);
      handle.stream.end();
      handle.stream.detach();
    }
    return true;
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

// AGEWORK_AGENT_EVENT_TRACE_ENABLED 只控制 raw/agui 大 payload 是否落 JSONL 文件（"trace" 这里指完整证据，
// 不是事件索引）。DB 关键事件索引（RunEventService 写入的 RunEvent）与本开关无关，始终记录，
// 关闭本开关后 run 仍可在管理端看到事件摘要，只是看不到完整 raw/agui payload 原文。
function buildAgentEventTraceConfig(input: {
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
  const enabled = isTruthy(process.env[EnvKey.AGENT_EVENT_TRACE_ENABLED]);
  const maxFileMb = parsePositiveInt(
    process.env[EnvKey.AGENT_EVENT_TRACE_MAX_FILE_MB],
    DEFAULT_AGENT_EVENT_TRACE_MAX_FILE_MB
  );

  return {
    enabled,
    logDir: enabled ? input.logDir : undefined,
    rawFilePath: enabled ? input.rawFilePath : undefined,
    rawRuntimeFilePath: enabled ? input.rawRuntimeFilePath : undefined,
    aguiFilePath: enabled ? input.aguiFilePath : undefined,
    aguiRuntimeFilePath: enabled ? input.aguiRuntimeFilePath : undefined,
    maxFileMb,
    runId: input.runId,
    conversationId: input.conversationId,
    workspaceId: input.workspaceId,
    agentType: input.agentType,
  };
}

function isTruthy(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}
