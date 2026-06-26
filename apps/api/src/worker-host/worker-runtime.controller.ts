import { Controller, Get, Post, Param, Query, UseGuards, Logger } from "@nestjs/common";
import type { Envelope } from "@agework/shared/protocol";
import { Public } from "../auth/public.decorator";
import { RawResponse } from "../common/decorators/raw-response.decorator";
import { WorkerAuthGuard } from "./auth.guard";
import { RuntimeControlQueue } from "./control-queue";
import { WorkerAccessService } from "./access.service";
import { RuntimeHeartbeatRegistry } from "./runtime-heartbeat.registry";
import { safeLogJson } from "../common/logging";

const MAX_CONTROL_WAIT_MS = 30_000;

/**
 * Worker runtime resource API — 仅供持久容器内的 worker 调用。
 * 与 WorkerWorkspaceController 类似，但以 runtimeInstanceId 为分区键，
 * 使得 user scope 下同一容器可服务多个 workspace 的请求。
 */
@Public()
@RawResponse()
@Controller("worker/runtimes")
@UseGuards(WorkerAuthGuard)
export class WorkerRuntimeController {
  private readonly logger = new Logger(WorkerRuntimeController.name);

  constructor(
    private readonly controlQueue: RuntimeControlQueue,
    private readonly runtimeAccess: WorkerAccessService,
    private readonly heartbeatRegistry: RuntimeHeartbeatRegistry
  ) {}

  /**
   * GET /worker/runtimes/:runtimeInstanceId/controls?afterSeq=N
   * 持久容器的 worker 按 runtimeInstanceId 轮询下行控制指令。
   */
  @Get(":runtimeInstanceId/controls")
  async pollRuntimeControls(
    @Param("runtimeInstanceId") runtimeInstanceId: string,
    @Query("afterSeq") afterSeq?: string,
    @Query("waitMs") waitMs?: string
  ): Promise<{ controls: Envelope[] }> {
    const parsed = afterSeq ? parseInt(afterSeq, 10) : 0;
    const seq = Number.isFinite(parsed) ? parsed : 0;
    const wait = parseControlWaitMs(waitMs);
    const scopeKey =
      this.runtimeAccess.getScopeKeyForRuntimeInstance(runtimeInstanceId);
    const controls = scopeKey
      ? wait > 0
        ? await this.controlQueue.waitForWorkspace(scopeKey, seq, wait)
        : this.controlQueue.pollByWorkspace(scopeKey, seq)
      : [];
    if (controls.length > 0) {
      this.logger.debug(
        `runtime controls fetched ${safeLogJson({
          runtimeInstanceId,
          scopeKey,
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
   * POST /worker/runtimes/:runtimeInstanceId/heartbeat
   * 持久容器 worker 定期上报心跳，通过 runtimeInstanceId 反查 scopeKey
   * 后分发到对应 provider。
   */
  @Post(":runtimeInstanceId/heartbeat")
  async heartbeat(
    @Param("runtimeInstanceId") runtimeInstanceId: string
  ): Promise<{ ok: boolean }> {
    const scopeKey =
      this.runtimeAccess.getScopeKeyForRuntimeInstance(runtimeInstanceId);
    if (scopeKey) {
      this.logger.debug(
        `runtime heartbeat ${safeLogJson({ runtimeInstanceId, scopeKey })}`
      );
      this.heartbeatRegistry.heartbeatRuntimeInstance(scopeKey);
    } else {
      this.logger.warn(
        `runtime heartbeat without resource ${safeLogJson({ runtimeInstanceId })}`
      );
    }
    return { ok: true };
  }
}

function parseControlWaitMs(value?: string): number {
  const parsed = value ? parseInt(value, 10) : 0;
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.min(parsed, MAX_CONTROL_WAIT_MS);
}
