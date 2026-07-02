import { Controller, Get, Post, Param, Body } from "@nestjs/common";
import type { RunConfig } from "@agework/shared/protocol";
import { Public } from "../auth/decorators/public.decorator";
import { RawResponse } from "../common/decorators/raw-response.decorator";
import { WorkerHostService } from "./worker-host.service";
import { WorkerRunParamDto } from "./dto/worker-run-param.dto";
import { WorkerEventPostBodyDto } from "./dto/worker-event-post-body.dto";

/**
 * Worker run API（run-scoped）— 仅供 worker 调用，不暴露给前端。
 * 与用户登录态无关，因此标记 @Public() 跳过全局 JwtAuthGuard。
 * 开发阶段暂时移除了 run-scoped worker access key 鉴权，待生命周期管理理清后再补。
 *
 * config 下发与事件上报都经 WorkerHostService facade 进入 worker-host，
 * controller 不直接依赖内部 store / registry。
 */
@Public()
@RawResponse()
@Controller("worker/runs")
export class WorkerRunController {
  constructor(private readonly workerHost: WorkerHostService) {}

  /**
   * GET /worker/runs/:runId
   * Worker 启动后拉取 RunConfig（sandbox worker 通过 HTTP 启动时使用）。
   */
  @Get(":runId")
  getRunConfig(@Param() params: WorkerRunParamDto): { config: RunConfig } {
    return this.workerHost.getRunConfig(params.runId);
  }

  /**
   * POST /worker/runs/:runId/events
   * Worker 上报上行事件，转发给 run 层处理。
   */
  @Post(":runId/events")
  async postEvent(
    @Param() params: WorkerRunParamDto,
    @Body() body: WorkerEventPostBodyDto
  ): Promise<{ ok: boolean }> {
    return this.workerHost.postEvent(params.runId, body);
  }
}
