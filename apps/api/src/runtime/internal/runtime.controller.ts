import { Controller, Get, Post, Param, Query, UseGuards, Logger } from "@nestjs/common";
import type { Envelope } from "@agework/shared/protocol";
import { Public } from "../../auth/public.decorator";
import { RawResponse } from "../../common/decorators/raw-response.decorator";
import { RuntimeInternalAuthGuard } from "./auth.guard";
import { RuntimeControlQueue } from "./control-queue";
import { RuntimeInternalAccessService } from "./access.service";
import { RuntimeService } from "../runtime.service";
import { safeLogJson } from "../../common/logging";

const MAX_CONTROL_WAIT_MS = 30_000;

/**
 * Internal runtime resource API — 仅供持久容器内的 worker 调用。
 * 与 RuntimeWorkspaceController 类似，但以 RuntimeTarget.id 为分区键，
 * 使得 user scope 下同一容器可服务多个 workspace 的请求。
 */
@Public()
@RawResponse()
@Controller("internal/runtimes")
@UseGuards(RuntimeInternalAuthGuard)
export class RuntimeRuntimeController {
  private readonly logger = new Logger(RuntimeRuntimeController.name);

  constructor(
    private readonly controlQueue: RuntimeControlQueue,
    private readonly runtimeAccess: RuntimeInternalAccessService,
    private readonly runtimeService: RuntimeService
  ) {}

  /**
   * GET /internal/runtimes/:runtimeInstanceId/controls?afterSeq=N
   * 持久容器的 worker 按 RuntimeTarget.id 轮询下行控制指令。
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
    const resourceKey =
      this.runtimeAccess.getResourceKeyForRuntimeInstance(runtimeInstanceId);
    const controls = resourceKey
      ? wait > 0
        ? await this.controlQueue.waitForWorkspace(resourceKey, seq, wait)
        : this.controlQueue.pollByWorkspace(resourceKey, seq)
      : [];
    if (controls.length > 0) {
      this.logger.debug(
        `runtime controls fetched ${safeLogJson({
          runtimeInstanceId,
          resourceKey,
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
   * POST /internal/runtimes/:runtimeInstanceId/heartbeat
   * 持久容器 worker 定期上报心跳，通过 RuntimeTarget.id 反查 resourceKey
   * 后分发到对应 provider。
   */
  @Post(":runtimeInstanceId/heartbeat")
  async heartbeat(
    @Param("runtimeInstanceId") runtimeInstanceId: string
  ): Promise<{ ok: boolean }> {
    const resourceKey =
      this.runtimeAccess.getResourceKeyForRuntimeInstance(runtimeInstanceId);
    if (resourceKey) {
      this.logger.debug(
        `runtime heartbeat ${safeLogJson({ runtimeInstanceId, resourceKey })}`
      );
      this.runtimeService.heartbeatRuntimeInstance(resourceKey);
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
