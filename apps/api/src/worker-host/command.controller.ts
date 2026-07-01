import { Controller, Get, Param, Query } from "@nestjs/common";
import { Public } from "../auth/decorators/public.decorator";
import { RawResponse } from "../common/decorators/raw-response.decorator";
import { WorkerHostService } from "./worker-host.service";
import {
  WorkerCommandQueryDto,
  WorkerOwnerParamDto,
} from "./dto/worker-command-query.dto";

/**
 * Worker command API — 仅供持久容器内的 worker 调用。
 * 提供 owner 级命令轮询：一个 ownerId（user 或 workspace 隔离粒度）
 * 对应一个长期容器，容器内常驻 worker 同时服务该 owner 下多个并行 run。
 */
@Public()
@RawResponse()
@Controller("worker/owners")
export class WorkerCommandController {
  constructor(private readonly workerHost: WorkerHostService) {}

  /**
   * GET /worker/owners/:ownerId/commands?afterSeq=N
   * 持久容器的 worker 按 ownerId 轮询下行命令，
   * 每条 JSON-RPC request 的 meta/params 携带 runId，worker 据此分发到对应的并行 run。
   */
  @Get(":ownerId/commands")
  pollCommands(
    @Param() params: WorkerOwnerParamDto,
    @Query() query: WorkerCommandQueryDto
  ) {
    return this.workerHost.pollCommands(params.ownerId, query);
  }
}
