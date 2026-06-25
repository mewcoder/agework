import {
  Injectable,
  Logger,
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { generateId } from "@agework/shared";
import type { Response } from "express";
import type { RunConfig, WorkerExecutionHandle } from "@agework/shared/protocol";
import { Prisma } from "../../generated/prisma/client.js";
import { RunRepository } from "./run.repository";
import { RunActiveStore } from "./execution/run-active.store";
import { RuntimeService } from "../runtime/runtime.service";
import { RunWorkerExecutionService } from "./execution/run-worker-execution.service";
import { ConversationService } from "../conversations/conversation.service";
import { TitleService } from "../conversations/title.service";
import {
  RunMessageAggregator,
  type IncompleteMessageReason,
} from "./execution/run-message.aggregator";
import { RunConfigAssembler } from "./run-config.assembler";
import { ConfigService, type IsolationScope } from "../config/config.service";
import { swallow } from "../common/swallow";
import { errorLogFields, safeLogJson } from "../common/logging";
import { RunEventRecorder } from "./events/run-event-recorder";
import { RunEventFacts, compactData } from "./events/run-event-facts";
import type { StartRunInput } from "./run-service.types";
import { PrismaService } from "../prisma/prisma.service";

type RunWorkspace = {
  workspaceId: string;
  workspaceRootPath: string;
  runtimeType?: string;
  isolationScope?: string | null;
  sandboxEngine?: string | null;
  username: string;
};

@Injectable()
export class RunService {
  private readonly logger = new Logger(RunService.name);

  constructor(
    private readonly runRepository: RunRepository,
    private readonly runRegistry: RunActiveStore,
    private readonly runtimeService: RuntimeService,
    private readonly runWorkerExecution: RunWorkerExecutionService,
    private readonly conversationService: ConversationService,
    private readonly runEventRecorder: RunEventRecorder,
    private readonly runConfigAssembler: RunConfigAssembler,
    private readonly titleService: TitleService,
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService
  ) {}

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
    const workspace = await this.resolveRunWorkspace(workspaceId);

    // 1. 校验 runtime/isolation 是否被部署允许，并解析 placement
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
    const placement = this.runtimeService.resolvePlacement({
      userId,
      workspaceId: workspace.workspaceId,
      workspaceRootPath: workspace.workspaceRootPath,
      userWorkspaceRootPath: this.configService.getUserWorkspace(
        workspace.username,
      ),
      runtimeType: requestedRuntimeType,
      isolationScope,
      sandboxEngine: workspace.sandboxEngine ?? undefined,
    });
    const runtimeResource = await this.runtimeService.provision(placement);
    const runtimeType = placement.runtimeType;
    const sandbox =
      placement.runtimeType === "sandbox" ? placement.sandbox : undefined;

    // 2. 组装 RunConfig（agent provider 由 agent 层提供，路径/trace 由 placement 决定）
    let runConfig: RunConfig;
    try {
      runConfig = this.runConfigAssembler.assemble({
        agentProviderConfig,
        placement,
        workspaceId: workspace.workspaceId,
        runId,
        conversationId,
        input: runInput,
      });
    } catch (err) {
      throw new BadRequestException(
        err instanceof Error ? err.message : String(err)
      );
    }

    // 3. SSE 响应头
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    // 4. 并发守卫：乐观锁尝试把 conversation 置为 running
    // setActiveRunStatus 内部只在 activeRunStatus in ["idle", "error"] 时才更新为 running
    if (conversationId) {
      const result = await this.conversationService.setActiveRunStatus(
        conversationId,
        "running"
      );

      if (result.count === 0) {
        // 更新失败，查询当前状态以区分情况
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

    // 5. 保存用户消息 + 触发会话标题（标题只依赖首条用户消息，与助手回复并行）
    if (conversationId && userMessage) {
      await this.conversationService.saveUserMessage(
        conversationId,
        userMessage
      );

      this.titleService
        .generateIfNeeded({ conversationId, agentType, modelProviderId })
        .catch(
          swallow(
            this.logger,
            `generate title for conversation ${conversationId}`
          )
        );
    }

    // 6. aggregator + saveRun
    const aggregator = new RunMessageAggregator();
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

    // 7. agent session id 回写
    const onAgentSessionId = (sessionId: string) => {
      this.conversationService
        .setAgentSessionId(conversationId, sessionId)
        .catch(
          swallow(this.logger, `persist agent session for ${conversationId}`)
        );
    };

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

    // Create Run record
    try {
      await this.runRepository.create({
        id: runId,
        conversationId,
        agentType,
        runtimeType,
      });
      this.runEventRecorder
        .append(
          RunEventFacts.runCreated({
            runId,
            conversationId,
            workspaceId: placement.workspaceId,
            agentType,
            runtimeType,
            isolationScope: sandbox?.isolationScope,
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
        this.runEventRecorder
          .append(
            RunEventFacts.messageAccepted({
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
    } catch (err) {
      this.logger.warn(
        `create run record failed ${safeLogJson({
          runId,
          conversationId,
          ...errorLogFields(err),
        })}`
      );
      if (!res.writableEnded) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        res.write(
          `data: ${JSON.stringify({ type: "RUN_ERROR", threadId: conversationId, runId, message: errorMsg })}\n\n`
        );
        res.end();
      }
      return;
    }

    // Start worker through the Run-layer execution boundary.
    let runtimeHandle: WorkerExecutionHandle;
    try {
      this.runEventRecorder
        .append(
          RunEventFacts.runtimeStatusChanged({
            runId,
            status: "starting",
            runtimeType,
            isolationScope: sandbox?.isolationScope,
            sandboxEngineType: sandbox?.sandboxEngineType,
          })
        )
        .catch(
          swallow(this.logger, `record runtime starting for run ${runId}`)
        );
      runtimeHandle = this.runWorkerExecution.start({
        runConfig,
        runtimeResource,
        onRuntimeResourceIdReady: (runtimeResourceId) => {
          this.runRepository
            .updateRuntimeHandle(runId, runtimeType, runtimeResourceId)
            .catch(
              swallow(this.logger, `persist runtime handle for run ${runId}`)
            );
          this.runEventRecorder
            .append(
              RunEventFacts.runtimeStatusChanged({
                runId,
                eventKey: `runtime:${runtimeResourceId}:ready`,
                status: "ready",
                targetId: runtimeResourceId,
                runtimeType,
                runtimeResourceId,
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
      this.runEventRecorder
        .append(
          RunEventFacts.runtimeStatusChanged({
            runId,
            status: "start_failed",
            error: err instanceof Error ? err.message : String(err),
            data: compactData(errorLogFields(err)),
          })
        )
        .catch(
          swallow(this.logger, `record runtime start failure for run ${runId}`)
        )
        .finally(() => this.runEventRecorder.forgetRun(runId));
      await this.conversationService
        .setActiveRunStatus(conversationId, "error")
        .catch(
          swallow(
            this.logger,
            `set conversation active run status to error for run ${runId}`
          )
        );
      if (!res.writableEnded) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        res.write(
          `data: ${JSON.stringify({ type: "RUN_ERROR", threadId: conversationId, runId, message: "启动 worker 失败: " + errorMsg })}\n\n`
        );
        res.end();
      }
      return;
    }

    // Persist runtime handle for orphan recovery after a service restart.
    if (runtimeHandle.runtimeResourceId) {
      await this.runRepository
        .updateRuntimeHandle(
          runId,
          runtimeHandle.runtimeType,
          runtimeHandle.runtimeResourceId
        )
        .catch(swallow(this.logger, `persist runtime handle for run ${runId}`));
      this.runEventRecorder
        .append(
          RunEventFacts.runtimeStatusChanged({
            runId,
            eventKey: `runtime:${runtimeHandle.runtimeResourceId}:ready`,
            status: "ready",
            targetId: runtimeHandle.runtimeResourceId,
            runtimeType: runtimeHandle.runtimeType,
            runtimeResourceId: runtimeHandle.runtimeResourceId,
          })
        )
        .catch(swallow(this.logger, `record runtime ready for run ${runId}`));
    }

    // Register with RunActiveStore
    this.runRegistry.register(runId, {
      runtimeHandle,
      res,
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

    // SSE disconnect: null out the response ref (don't cancel the run)
    res.on("close", () => {
      const handle = this.runRegistry.get(runId);
      if (handle) {
        handle.res = null;
      }
    });
    this.logger.log(
      `run registered ${safeLogJson({
        runId,
        conversationId,
        runtimeType,
        runtimeResourceId: runtimeHandle.runtimeResourceId,
      })}`
    );
  }

  async resolveApproval(
    conversationId: string,
    answers: Record<string, string | string[]>
  ): Promise<void> {
    const activeRun =
      await this.runRepository.findActiveByConversationId(conversationId);
    const handle = activeRun ? this.runRegistry.get(activeRun.id) : undefined;
    if (!handle) {
      throw new NotFoundException(
        `No active run for conversation: ${conversationId}`
      );
    }
    this.runWorkerExecution.sendControl(handle.runtimeHandle, {
      type: "approval_resolved",
      commandId: generateId(),
      conversationId,
      answers: answers ?? {},
    });
  }

  /**
   * 刷新网页后续接一个进行中的 run：把新的 SSE response 接到活跃 run 的 handle 上，
   * 以「累积快照」模式推送（streamingSnapshot=true）。前端 ThreadHistoryAdapter.resume
   * 直接 yield 这些快照，实现刷新后实时续接。
   *
   * 处理三种情况：
   *  - 活跃 run 且 status=running：补发当前累积快照，替换 res，后续事件转快照推送。
   *  - 活跃 run 但 status=requires_action：首版不接 stream，返回 409 让前端走正常 load+审批。
   *  - 无活跃 run / 无内存 handle（已结束）：发一个终态 complete 快照并 end，
   *    让前端 resume 流正常收尾，不卡在 running。
   */
  async resumeStream(conversationId: string, res: Response): Promise<void> {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const activeRunRecord =
      await this.runRepository.findActiveByConversationId(conversationId);
    const handle = activeRunRecord
      ? this.runRegistry.get(activeRunRecord.id)
      : undefined;

    // run 已结束 / 无内存 handle：发终态快照收尾
    if (!handle) {
      this.writeSnapshot(res, {
        content: [],
        status: { type: "complete", reason: "unknown" },
      });
      if (!res.writableEnded) res.end();
      return;
    }

    // 等待审批的 run 首版不续接 stream（前端走正常 load 显示历史 + 审批 UI）
    if (activeRunRecord?.status === "requires_action") {
      res.status(409);
      if (!res.writableEnded) res.end();
      return;
    }

    // 补发当前累积快照（resume 流的起点，含已输出的全部内容）
    const initial = handle.aggregator.build(false, "streaming");
    this.writeSnapshot(res, this.toRunResult(initial));

    // 接管 SSE 连接：原连接（刷新前）已断，单订阅直接替换
    // 守卫：若旧 res 尚未关闭（close 事件未触发的 race condition），主动 end 防连接泄漏
    const oldRes = handle.res;
    if (oldRes && !oldRes.writableEnded) {
      oldRes.end();
    }
    handle.res = res;
    handle.streamingSnapshot = true;
    res.on("close", () => {
      // 连接断开只清引用，不取消 run（与正常 run 的 res.on close 一致）
      const current = this.runRegistry.get(handle.runId);
      if (current && current.res === res) {
        current.res = null;
        current.streamingSnapshot = false;
      }
    });
  }

  private async resolveRunWorkspace(workspaceId: string): Promise<RunWorkspace> {
    const workspace = await this.prisma.workspace.findFirst({
      where: { id: workspaceId, deletedAt: null },
      include: { directory: true, user: { select: { username: true } } },
    });
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

  /** 把 aggregator.build() 的快照转成 ChatModelRunResult 形态并写成 SSE。 */
  private writeSnapshot(
    res: Response,
    result: { content: unknown[]; status: unknown; metadata?: unknown }
  ): void {
    if (res.writableEnded) return;
    res.write(`data: ${JSON.stringify(result)}\n\n`);
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
      ? this.runRegistry.get(activeRunRecord.id)
      : undefined;
    if (!handle) {
      // No in-memory handle — clean up stale state
      if (activeRunRecord) {
        await this.runRepository.markCancelled(activeRunRecord.id);
        this.runEventRecorder
          .append(
            RunEventFacts.runStatusChanged({
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
      this.runEventRecorder
        .append(
          RunEventFacts.runStatusChanged({
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
    this.runWorkerExecution.cancel(handle.runtimeHandle);
    if (options?.endResponse) {
      handle.saveRun(false, options.reason);
      if (handle.res && !handle.res.writableEnded) {
        handle.res.end();
      }
      handle.res = null;
    }
    return true;
  }
}
