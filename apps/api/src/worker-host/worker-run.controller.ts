import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  UseGuards,
  NotFoundException,
  Logger,
} from "@nestjs/common";
import type { Envelope, RunConfig } from "@agework/shared/protocol";
import { Public } from "../auth/public.decorator";
import { RawResponse } from "../common/decorators/raw-response.decorator";
import { WorkerAuthGuard } from "./auth.guard";
import { WorkerConfigStore } from "./config-store";
import { WorkerUpstreamRegistry } from "./worker-upstream.registry";
import { safeLogJson } from "../common/logging";

/**
 * Worker run API（run-scoped）— 仅供 worker 调用，不暴露给前端。
 * 所有端点需要 run-scoped worker access key，与用户登录态无关，因此标记 @Public()
 * 跳过全局 JwtAuthGuard，鉴权完全交由 WorkerAuthGuard。
 *
 * config 下发由 worker-host 自持的 WorkerConfigStore 完成；事件上报经
 * WorkerUpstreamRegistry 转发给 run 层（worker-host 不依赖 run 实现）。
 */
@Public()
@RawResponse()
@Controller("worker/runs")
@UseGuards(WorkerAuthGuard)
export class WorkerRunController {
  private readonly logger = new Logger(WorkerRunController.name);

  constructor(
    private readonly configStore: WorkerConfigStore,
    private readonly upstream: WorkerUpstreamRegistry
  ) {}

  /**
   * GET /worker/runs/:runId
   * Worker 启动后拉取 RunConfig（sandbox worker 通过 HTTP 启动时使用）。
   */
  @Get(":runId")
  async getRunConfig(
    @Param("runId") runId: string
  ): Promise<{ config: RunConfig }> {
    const config = this.configStore.get(runId);
    if (!config) {
      this.logger.warn(`Run config not found runId=${runId}`);
      throw new NotFoundException(`Run config not found: ${runId}`);
    }
    this.logger.debug(
      `run config fetched ${safeLogJson({
        runId,
        conversationId: config.conversationId,
        workspaceId: config.workspaceId,
        agentType: config.agentProviderConfig.agentType,
        agentProviderSource: config.agentProviderConfig.source,
      })}`
    );
    return { config };
  }

  /**
   * POST /worker/runs/:runId/events
   * Worker 上报上行事件，转发给 run 层处理。
   */
  @Post(":runId/events")
  async postEvent(
    @Param("runId") runId: string,
    @Body() envelope: Envelope
  ): Promise<{ ok: boolean }> {
    await this.upstream.sendEvent(runId, envelope);
    return { ok: true };
  }
}
