import {
  Body,
  Controller,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import type { WorkspaceFileCommandResult } from "@agework/shared/protocol";
import { Public } from "../../auth/decorators/public.decorator";
import { RawResponse } from "../../common/decorators/raw-response.decorator";
import { WorkerManagerService } from "../worker-manager.service";
import {
  WorkerOwnerParamDto,
} from "../dto/worker-command-query.dto";
import { WorkerTokenGuard } from "./worker-token.guard";

/**
 * 文件命令结果回传端点——worker 处理完文件命令后直接 POST 回传,
 * 不经 command.result/RunEvent(见 ADR-0004)。
 *
 * 与 WorkerCommandController 同属 `worker/owners` 路由前缀,
 * 但物理上放在 connection/ 目录(与 store 同侧)。
 */
@Public()
@RawResponse()
@Controller("worker/owners")
export class WorkspaceFileCommandController {
  constructor(private readonly workerManager: WorkerManagerService) {}

  /**
   * POST /worker/owners/:ownerId/file-command-results
   * worker 处理完 list_files/read_file 后,经此端点直接回传结果。
   * server 侧按 commandId 匹配 pending Promise 并 resolve。
   */
  @Post(":ownerId/file-command-results")
  @UseGuards(WorkerTokenGuard)
  @HttpCode(200)
  postFileCommandResult(
    @Param() params: WorkerOwnerParamDto,
    @Body() body: WorkspaceFileCommandResult
  ): { ok: boolean } {
    this.workerManager.resolveFileCommandResult(body);
    return { ok: true };
  }
}
