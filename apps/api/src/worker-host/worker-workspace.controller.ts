import { Controller, Get, Post, Param, Query, UseGuards, Logger } from "@nestjs/common";
import type { Envelope } from "@agework/shared/protocol";
import { Public } from "../auth/public.decorator";
import { RawResponse } from "../common/decorators/raw-response.decorator";
import { WorkerAuthGuard } from "./auth.guard";
import { RuntimeControlQueue } from "./control-queue";
import { RuntimeHeartbeatRegistry } from "./runtime-heartbeat.registry";
import { safeLogJson } from "../common/logging";

const MAX_CONTROL_WAIT_MS = 30_000;

/**
 * Worker workspace API — 仅供持久容器内的 worker 调用。
 * 提供 workspace 级控制消息轮询端点：一个 workspace 对应一个长期容器，
 * 容器内常驻 worker 同时服务该 workspace 下多个并行 conversation。
 */
@Public()
@RawResponse()
@Controller("worker/workspaces")
@UseGuards(WorkerAuthGuard)
export class WorkerWorkspaceController {
  private readonly logger = new Logger(WorkerWorkspaceController.name);

  constructor(
    private readonly controlQueue: RuntimeControlQueue,
    private readonly heartbeatRegistry: RuntimeHeartbeatRegistry
  ) {}

  /**
   * GET /worker/workspaces/:workspaceId/controls?afterSeq=N
   * 持久容器的 worker 按 workspaceId 轮询下行控制指令，
   * 每条 envelope 携带 runId，worker 据此分发到对应的并行 run。
   */
  @Get(":workspaceId/controls")
  async pollWorkspaceControls(
    @Param("workspaceId") workspaceId: string,
    @Query("afterSeq") afterSeq?: string,
    @Query("waitMs") waitMs?: string
  ): Promise<{ controls: Envelope[] }> {
    const parsed = afterSeq ? parseInt(afterSeq, 10) : 0;
    const seq = Number.isFinite(parsed) ? parsed : 0;
    const wait = parseControlWaitMs(waitMs);
    const controls =
      wait > 0
        ? await this.controlQueue.waitForWorkspace(workspaceId, seq, wait)
        : this.controlQueue.pollByWorkspace(workspaceId, seq);
    if (controls.length > 0) {
      this.logger.debug(
        `workspace controls fetched ${safeLogJson({
          workspaceId,
          afterSeq: seq,
          count: controls.length,
          controls: controls.map((control) => ({
            seq: control.seq,
            runId: control.runId,
            type: control.payload.type,
          })),
        })}`
      );
    }
    return { controls };
  }

  /**
   * POST /worker/workspaces/:workspaceId/heartbeat
   * Docker 持久容器 worker 定期上报心跳；这里的 workspaceId 实际是 scopeKey。
   * 广播给所有 provider 喂 watchdog，不依赖 DB binding 是否可见。
   */
  @Post(":workspaceId/heartbeat")
  heartbeat(
    @Param("workspaceId") workspaceId: string
  ): { ok: boolean } {
    this.logger.debug(`Workspace heartbeat workspaceId=${workspaceId}`);
    this.heartbeatRegistry.heartbeatRuntimeInstance(workspaceId);
    return { ok: true };
  }
}

function parseControlWaitMs(value?: string): number {
  const parsed = value ? parseInt(value, 10) : 0;
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.min(parsed, MAX_CONTROL_WAIT_MS);
}
