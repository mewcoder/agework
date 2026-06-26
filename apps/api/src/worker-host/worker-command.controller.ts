import { Controller, Get, Post, Param, Query, UseGuards, Logger } from "@nestjs/common";
import type { Envelope } from "@agework/shared/protocol";
import { Public } from "../auth/public.decorator";
import { RawResponse } from "../common/decorators/raw-response.decorator";
import { WorkerAuthGuard } from "./auth.guard";
import { RuntimeCommandQueue } from "./command-queue";
import { RuntimeHeartbeatRegistry } from "./runtime-heartbeat.registry";
import { safeLogJson } from "../common/logging";

const MAX_COMMAND_WAIT_MS = 30_000;

/**
 * Worker command API — 仅供持久容器内的 worker 调用。
 * 提供 owner 级命令轮询与心跳端点：一个 ownerId（user 或 workspace 隔离粒度）
 * 对应一个长期容器，容器内常驻 worker 同时服务该 owner 下多个并行 run。
 */
@Public()
@RawResponse()
@Controller("worker/owners")
@UseGuards(WorkerAuthGuard)
export class WorkerCommandController {
  private readonly logger = new Logger(WorkerCommandController.name);

  constructor(
    private readonly commandQueue: RuntimeCommandQueue,
    private readonly heartbeatRegistry: RuntimeHeartbeatRegistry
  ) {}

  /**
   * GET /worker/owners/:ownerId/commands?afterSeq=N
   * 持久容器的 worker 按 ownerId 轮询下行命令，
   * 每条 envelope 携带 runId，worker 据此分发到对应的并行 run。
   */
  @Get(":ownerId/commands")
  async pollCommands(
    @Param("ownerId") ownerId: string,
    @Query("afterSeq") afterSeq?: string,
    @Query("waitMs") waitMs?: string
  ): Promise<{ commands: Envelope[] }> {
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
    return { commands };
  }

  /**
   * POST /worker/owners/:ownerId/heartbeat
   * 持久容器 worker 定期上报心跳；ownerId 由 worker 启动时通过
   * AGEWORK_WORKER_OWNER_ID env 获取。广播给所有 provider 喂 watchdog。
   */
  @Post(":ownerId/heartbeat")
  async heartbeat(
    @Param("ownerId") ownerId: string
  ): Promise<{ ok: boolean }> {
    this.logger.debug(`owner heartbeat ownerId=${ownerId}`);
    this.heartbeatRegistry.heartbeatRuntimeInstance(ownerId);
    return { ok: true };
  }
}

function parseCommandWaitMs(value?: string): number {
  const parsed = value ? parseInt(value, 10) : 0;
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.min(parsed, MAX_COMMAND_WAIT_MS);
}
