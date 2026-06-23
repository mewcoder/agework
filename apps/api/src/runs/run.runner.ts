import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { Response } from "express";
import type { RunConfig, RuntimeHandle, RuntimePlacement } from "@agework/shared/protocol";
import { RunRepository } from "./run.repository";
import { RunActiveStore } from "./execution/run-active.store";
import { RuntimeProviderRegistry } from "../runtime/providers/runtime-provider-registry";
import { ConversationService } from "../conversations/conversation.service";
import type { IncompleteMessageReason, RunMessageAggregator } from "./execution/run-message.aggregator";
import { swallow } from "../common/swallow";
import { errorLogFields, safeLogJson } from "../common/logging";
import { RunEventRecorder } from "./events/run-event-recorder";
import { RunEventFacts, compactData } from "./events/run-event-facts";

@Injectable()
export class RunRunner {
  private readonly logger = new Logger(RunRunner.name);

  constructor(
    private readonly runService: RunRepository,
    private readonly runRegistry: RunActiveStore,
    private readonly runtimeProviderRegistry: RuntimeProviderRegistry,
    private readonly conversationService: ConversationService,
    private readonly runEventRecorder: RunEventRecorder
  ) {}

  async start(params: {
    runId: string;
    conversationId: string;
    agentType: string;
    placement: RuntimePlacement;
    runConfig: RunConfig;
    res: Response;
    aggregator: RunMessageAggregator;
    saveRun: (complete: boolean, incompleteReason?: IncompleteMessageReason) => void;
    userMessageId?: string;
    userId?: string;
    onAgentSessionId?: (sessionId: string) => void;
  }): Promise<void> {
    const {
      runId,
      conversationId,
      placement,
      runConfig,
      res,
      aggregator,
      saveRun,
      userMessageId,
      userId,
      onAgentSessionId,
    } = params;
    const runtimeType = placement.runtimeType;
    this.logger.log(
      `run starting ${safeLogJson({
        runId,
        conversationId,
        workspaceId: placement.workspaceId,
        agentType: params.agentType,
        runtimeType,
        isolationScope: placement.isolationScope,
      })}`
    );

    // Create Run record
    try {
      await this.runService.create({
        id: runId,
        conversationId,
        agentType: params.agentType,
        runtimeType,
      });
      this.runEventRecorder
        .append(
          RunEventFacts.runCreated({
            runId,
            conversationId,
            workspaceId: placement.workspaceId,
            agentType: params.agentType,
            runtimeType,
            isolationScope: placement.isolationScope,
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
          .catch(swallow(this.logger, `record message accepted for run ${runId}`));
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

    // Start worker via provider
    const provider = this.runtimeProviderRegistry.resolve(runtimeType);
    let runtimeHandle: RuntimeHandle;
    try {
      this.runEventRecorder
        .append(
          RunEventFacts.runtimeStatusChanged({
            runId,
            status: "starting",
            runtimeType,
            isolationScope: placement.isolationScope,
            sandboxEngineType: placement.sandboxEngineType,
          })
        )
        .catch(swallow(this.logger, `record runtime starting for run ${runId}`));
      runtimeHandle = provider.start(runConfig, placement, (runtimeResourceId) => {
        this.runService
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
          .catch(swallow(this.logger, `record runtime ready for run ${runId}`));
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
      await this.runService
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
        .catch(swallow(this.logger, `record runtime start failure for run ${runId}`))
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
      await this.runService
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
      agentType: params.agentType,
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

  async sendApprovalResolved(
    conversationId: string,
    answers: Record<string, string | string[]>
  ): Promise<void> {
    const activeRun = await this.runService.findActiveByConversationId(conversationId);
    const handle = activeRun ? this.runRegistry.get(activeRun.id) : undefined;
    if (!handle) {
      throw new NotFoundException(`No active run for conversation: ${conversationId}`);
    }
    const provider = this.runtimeProviderRegistry.resolve(
      handle.runtimeHandle.runtimeType
    );
    provider.sendControl(handle.runtimeHandle, {
      type: "approval_resolved",
      commandId: randomUUID(),
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
  async attachStream(conversationId: string, res: Response): Promise<void> {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const activeRunRecord =
      await this.runService.findActiveByConversationId(conversationId);
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
      await this.runService.findActiveByConversationId(conversationId);
    const handle = activeRunRecord
      ? this.runRegistry.get(activeRunRecord.id)
      : undefined;
    if (!handle) {
      // No in-memory handle — clean up stale state
      if (activeRunRecord) {
        await this.runService.markCancelled(activeRunRecord.id);
        this.runEventRecorder
          .append(
            RunEventFacts.runStatusChanged({
              runId: activeRunRecord.id,
              origin: "platform",
              status: "cancelled",
              reason: "cancelled_without_handle",
            })
          )
          .catch(swallow(this.logger, `record cancel without handle for run ${activeRunRecord.id}`));
      }
      return false;
    }
    handle.stopRequested = true;
    handle.stopReason = options?.reason;
    if (activeRunRecord) {
      await this.runService.markCancelling(activeRunRecord.id);
      this.runEventRecorder
        .append(
          RunEventFacts.runStatusChanged({
            runId: activeRunRecord.id,
            origin: "platform",
            status: "cancelling",
            reason: options?.reason,
          })
        )
        .catch(swallow(this.logger, `record cancel request for run ${activeRunRecord.id}`));
    }
    const provider = this.runtimeProviderRegistry.resolve(
      handle.runtimeHandle.runtimeType
    );
    provider.cancel(handle.runtimeHandle);
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
