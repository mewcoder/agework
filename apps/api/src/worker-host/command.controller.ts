import {
  Controller,
  Get,
  Logger,
  Param,
  Query,
  UseGuards,
} from "@nestjs/common";
import type { WorkerCommandRpcRequest } from "@agework/shared/protocol";
import { commandMessageToRpcRequest } from "@agework/shared/protocol/rpc";
import { Public } from "../auth/decorators/public.decorator";
import { RawResponse } from "../common/decorators/raw-response.decorator";
import { WorkerAuthGuard } from "./auth.guard";
import { WorkerCommandQueue } from "./command-queue";
import { safeLogJson } from "../common/logging";

const MAX_COMMAND_WAIT_MS = 30_000;

/**
 * Worker command API — 仅供持久容器内的 worker 调用。
 * 提供 owner 级命令轮询：一个 ownerId（user 或 workspace 隔离粒度）
 * 对应一个长期容器，容器内常驻 worker 同时服务该 owner 下多个并行 run。
 */
@Public()
@RawResponse()
@Controller("worker/owners")
@UseGuards(WorkerAuthGuard)
export class WorkerCommandController {
  private readonly logger = new Logger(WorkerCommandController.name);

  constructor(private readonly commandQueue: WorkerCommandQueue) {}

  /**
   * GET /worker/owners/:ownerId/commands?afterSeq=N
   * 持久容器的 worker 按 ownerId 轮询下行命令，
   * 每条 JSON-RPC request 的 meta/params 携带 runId，worker 据此分发到对应的并行 run。
   */
  @Get(":ownerId/commands")
  async pollCommands(
    @Param("ownerId") ownerId: string,
    @Query("afterSeq") afterSeq?: string,
    @Query("waitMs") waitMs?: string
  ): Promise<{
    messages: WorkerCommandRpcRequest[];
  }> {
    const parsed = afterSeq ? parseInt(afterSeq, 10) : 0;
    const seq = Number.isFinite(parsed) ? parsed : 0;
    const wait = parseCommandWaitMs(waitMs);
    const commands =
      wait > 0
        ? await this.commandQueue.waitForOwnerId(ownerId, seq, wait)
        : this.commandQueue.pollByOwnerId(ownerId, seq);
    if (commands.length > 0) {
      this.logger.debug(
        `owner commands fetched ${safeLogJson({
          ownerId,
          afterSeq: seq,
          count: commands.length,
          commands: commands.map((command) => ({
            seq: command.seq,
            runId: command.runId,
            type: command.payload.type,
          })),
        })}`
      );
    }
    return { messages: commands.map(commandMessageToRpcRequest) };
  }
}

function parseCommandWaitMs(value?: string): number {
  const parsed = value ? parseInt(value, 10) : 0;
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.min(parsed, MAX_COMMAND_WAIT_MS);
}
