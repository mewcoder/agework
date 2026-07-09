import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { Public } from "../auth/decorators/public.decorator";
import { RawResponse } from "../common/decorators/raw-response.decorator";
import { WorkerManagerService } from "./worker-manager.service";
import {
  WorkerCommandQueryDto,
  WorkerWorkerIdParamDto,
} from "./dto/worker-command-query.dto";
import { RegisterWorkerDto } from "./dto/register-worker.dto";
import { WorkerTokenGuard } from "./connection/worker-token.guard";

/**
 * Worker command API — 仅供持久容器内的 worker 调用。
 * 提供 worker 级命令轮询：一个 workerId（Worker.id 主键）
 * 对应一个长期容器，容器内常驻 worker 同时服务该 worker 下多个并行 run。
 */
@Public()
@RawResponse()
@Controller("worker")
export class WorkerCommandController {
  constructor(private readonly workerManager: WorkerManagerService) {}

  /**
   * GET /worker/:workerId/commands?afterSeq=N
   * 持久容器的 worker 按 workerId 轮询下行命令，
   * 每条 JSON-RPC request 的 meta/params 携带 runId，worker 据此分发到对应的并行 run。
   */
  @Get(":workerId/commands")
  @UseGuards(WorkerTokenGuard)
  pollCommands(
    @Param() params: WorkerWorkerIdParamDto,
    @Query() query: WorkerCommandQueryDto
  ) {
    return this.workerManager.pollCommands(params.workerId, query);
  }

  /**
   * POST /worker/:workerId/register
   * worker 进程启动后主动回连注册,带上 launch 时下发的 startToken 证明自己是
   * server 期望的那个进程/容器,而不仅仅是"进程/容器起来了"。server 据此才把
   * 该 worker 判定为 running(见 WorkerHandshakeStore)。
   */
  @Post(":workerId/register")
  registerWorker(
    @Param() params: WorkerWorkerIdParamDto,
    @Body() body: RegisterWorkerDto
  ) {
    return this.workerManager.registerWorker(params.workerId, body);
  }
}
