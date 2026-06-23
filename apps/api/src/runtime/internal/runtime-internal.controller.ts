import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Query,
  UseGuards,
  NotFoundException,
  Logger,
} from "@nestjs/common";
import type { RunStatus } from "@agework/shared";
import type { Envelope, RunConfig, RunStatusPayload } from "@agework/shared/protocol";
import { Public } from "../../auth/public.decorator";
import { RawResponse } from "../../common/decorators/raw-response.decorator";
import { RuntimeInternalAuthGuard } from "./runtime-internal-auth.guard";
import { RunEnvelopeProcessor } from "../core/run-execution/run-envelope.processor";
import { RunActiveStore } from "../core/run-execution/run-active.store";
import { RuntimeConfigStore } from "./runtime-config-store";
import { RuntimeProviderRegistry } from "../providers/runtime-provider-registry";
import { RuntimeControlQueue } from "./runtime-control-queue";
import {
  safeLogJson,
  summarizeEnvelopePayload,
} from "../../common/logging";

const TERMINAL_RUN_STATUSES: RunStatus[] = ["finished", "error", "cancelled"];

/**
 * Internal runtime API — 仅供 worker 调用，不暴露给前端。
 * 所有端点需要 run-scoped internal access key，与用户登录态无关，
 * 因此标记 @Public() 以跳过全局 JwtAuthGuard，鉴权完全交由 RuntimeInternalAuthGuard。
 */
@Public()
@RawResponse()
@Controller("internal/runs")
@UseGuards(RuntimeInternalAuthGuard)
export class RuntimeInternalController {
  private readonly logger = new Logger(RuntimeInternalController.name);

  constructor(
    private readonly runEventProcessor: RunEnvelopeProcessor,
    private readonly runConfigStore: RuntimeConfigStore,
    private readonly runRegistry: RunActiveStore,
    private readonly runtimeProviderRegistry: RuntimeProviderRegistry,
    private readonly controlQueue: RuntimeControlQueue
  ) {}

  /**
   * GET /internal/runs/:runId
   * Worker 启动后拉取 RunConfig。
   */
  @Get(":runId")
  async getRunConfig(
    @Param("runId") runId: string
  ): Promise<{ config: RunConfig }> {
    // RunConfig 在 provider.start() 时暂存到 RuntimeConfigStore 内存 registry
    const config = this.runConfigStore.get(runId);
    if (!config) {
      this.logger.warn(`Run config not found runId=${runId}`);
      throw new NotFoundException(`Run config not found: ${runId}`);
    }
    this.logger.debug(
      `run config fetched ${safeLogJson({
        runId,
        conversationId: config.conversationId,
        workspaceId: config.workspaceId,
        agentType: config.agentType,
        adapterKind: config.adapter.kind,
      })}`
    );
    return { config };
  }

  /**
   * POST /internal/runs/:runId/events
   * Worker 上报上行事件（run.status / agui.event / sdk.raw / heartbeat）。
   */
  @Post(":runId/events")
  async postEvent(
    @Param("runId") runId: string,
    @Body() envelope: Envelope
  ): Promise<{ ok: boolean }> {
    this.logger.debug(
      `worker event received ${safeLogJson({
        runId,
        envelopeRunId: envelope.runId,
        seq: envelope.seq,
        type: envelope.type,
        payload: summarizeEnvelopePayload(envelope.payload),
      })}`
    );
    // 发布前先取出 handle：RunEnvelopeProcessor 在终态时会 unregister，之后就拿不到 runtimeType 了
    const handle = this.runRegistry.get(runId);

    // RunEnvelopeProcessor 内部做 seq 去重
    await this.runEventProcessor.publish(envelope).catch((err) => {
      this.logger.warn(
        `RunEnvelopeProcessor.publish failed for runId=${runId}: ${String(err)}`
      );
    });

    // worker 心跳上报：喂给对应 provider 的心跳 watchdog（HTTP transport 场景下
    // 这是唯一的喂狗入口，IPC transport 由 child.on("message") 直接喂狗）。
    if (envelope.type === "heartbeat" && handle) {
      this.runtimeProviderRegistry
        .resolve(handle.runtimeHandle.runtimeType)
        .heartbeat(runId);
    }

    // worker 上报终态后清理 provider 内部状态（心跳定时器等），
    // 避免心跳超时分支在 run 已结束后仍触发并覆盖终态。
    if (envelope.type === "run.status") {
      const { status } = envelope.payload as RunStatusPayload;
      if (TERMINAL_RUN_STATUSES.includes(status) && handle) {
        this.runtimeProviderRegistry
          .resolve(handle.runtimeHandle.runtimeType)
          .cleanup(runId);
      }
    }

    return { ok: true };
  }

  /**
   * GET /internal/runs/:runId/controls?afterSeq=N
   * Worker 轮询下行控制指令。
   */
  @Get(":runId/controls")
  async pollControls(
    @Param("runId") runId: string,
    @Query("afterSeq") afterSeq?: string
  ): Promise<{ controls: Envelope[] }> {
    const parsed = afterSeq ? parseInt(afterSeq, 10) : 0;
    const seq = Number.isFinite(parsed) ? parsed : 0;
    const controls = this.controlQueue.poll(runId, seq);
    if (controls.length > 0) {
      this.logger.debug(
        `run controls fetched ${safeLogJson({
          runId,
          afterSeq: seq,
          count: controls.length,
        })}`
      );
    }
    return { controls };
  }
}
