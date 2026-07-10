import { Controller, Get, Post, Param, Body, UseGuards } from "@nestjs/common";
import type { RunConfig } from "@agework/shared/protocol";
import { Public } from "../auth/decorators/public.decorator";
import { RawResponse } from "../common/decorators/raw-response.decorator";
import { WorkerManagerService } from "./worker-manager.service";
import { WorkerRunParamDto } from "./dto/worker-run-param.dto";
import { WorkerTokenGuard } from "./connection/worker-token.guard";

/**
 * Worker run API（run-scoped）— 仅供 worker 调用，不暴露给前端。
 * 与用户登录态无关，因此标记 @Public() 跳过全局 JwtAuthGuard。
 * URL 里只有 runId，没有 ownerId，鉴权靠 WorkerTokenGuard 退回读
 * `x-agework-owner-id` header（见 WorkerTokenGuard 注释）。
 *
 * config 下发与事件上报都经 WorkerManagerService facade 进入 worker-manager，
 * controller 不直接依赖内部 store / registry。
 */
@Public()
@RawResponse()
@Controller("worker/runs")
export class WorkerRunController {
  constructor(private readonly workerManager: WorkerManagerService) {}

  /**
   * GET /worker/runs/:runId
   * Worker 启动后拉取 RunConfig（sandbox worker 通过 HTTP 启动时使用）。
   */
  @Get(":runId")
  @UseGuards(WorkerTokenGuard)
  getRunConfig(@Param() params: WorkerRunParamDto): { config: RunConfig } {
    return this.workerManager.getRunConfig(params.runId);
  }

  /**
   * POST /worker/runs/:runId/events
   * Worker 上报上行事件，转发给 run 层处理。body 是单条上行事件或其数组
   * （worker 在事件产出快过 POST 往返时会合批），结构校验与 runId 归属校验都在
   * WorkerEndpointHandler.postEvent()→parseWorkerEventPostBody 里完成，非法即 400。
   */
  @Post(":runId/events")
  @UseGuards(WorkerTokenGuard)
  async postEvent(
    @Param() params: WorkerRunParamDto,
    @Body() body: unknown
  ): Promise<{ ok: boolean }> {
    return this.workerManager.postEvent(params.runId, body);
  }
}
