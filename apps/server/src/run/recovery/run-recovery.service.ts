import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
} from "@nestjs/common";
import type { RuntimeHostContract } from "@agework/shared/protocol";
import { RunRepository } from "../run.repository";
import { RUNTIME_HOST_CONTRACT } from "../../runtime-host/runtime-host.types";
import { ConversationService } from "../../conversation/conversation.service";
import { RuntimeService } from "../../runtime/runtime.service";
import { isBuiltinHostId } from "../../runtime/runtime.types";
import { ConfigService } from "../../config/config.service";
import { swallow } from "../../common/swallow";

/**
 * 服务重启后恢复中断 run,按 Host 归属分流(Phase 2):
 * - builtin Host 与 server 同生共死,其上的 run 无法续接,启动时统一判死。
 * - registered Host 独立于 server 存活,其上进行中的 run **不判死**:Host 重连
 *   后按 ACK 水位补发事件流,run 自然续传。命令与清理由调用方携带
 *   `runtimeHostId + runId`,server 不重建物理实例索引。
 *
 * 兜底:registered Host 一直不回来时,run 不能永远挂着——定时 sweep 把
 * 「绑定的 registered Host 已 offline 且心跳静默超过 2× 判死窗口」的 active run
 * 判死。这同时覆盖运行期整机失联(不只是 server 重启窗口)。
 */
@Injectable()
export class RunRecoveryService implements OnApplicationShutdown {
  private readonly logger = new Logger(RunRecoveryService.name);
  private sweepTimer?: NodeJS.Timeout;

  constructor(
    private readonly runRepository: RunRepository,
    private readonly conversationService: ConversationService,
    private readonly runtimeService: RuntimeService,
    private readonly configService: ConfigService,
    @Inject(RUNTIME_HOST_CONTRACT)
    private readonly runtimeHost: RuntimeHostContract
  ) {}

  onApplicationShutdown(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
  }

  async failInterruptedRuns(): Promise<void> {
    try {
      const activeRuns = await this.runRepository.listActive();
      if (activeRuns.length === 0) {
        this.logger.log("No interrupted active runs found.");
      } else {
        for (const run of activeRuns) {
          const runtimeHostId = run.conversation.workspace.runtimeHostId;
          if (!isBuiltinHostId(runtimeHostId)) {
            // registered Host 上的 run 等 Host 重连按 ACK 水位续传,不判死;
            // Host 一直不回来由 sweepAbandonedRuns 兜底。
            this.logger.log(
              `Run ${run.id} lives on registered host ${runtimeHostId} — waiting for reconnection instead of failing it`
            );
            continue;
          }

          await this.failRun(
            run.id,
            run.conversationId,
            "服务重启导致运行中断"
          );
          this.logger.log(`Marked interrupted run ${run.id} as error`);
        }
      }
    } catch (err) {
      this.logger.error(
        `Failed to cleanup interrupted runs: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    this.startAbandonedSweep();
  }

  /** 定时兜底:registered Host 离线超时后,其上的 active run 判死。 */
  private startAbandonedSweep(): void {
    if (this.sweepTimer) return;
    const intervalMs =
      this.configService.getHeartbeatCheckIntervalSeconds() * 1000;
    this.sweepTimer = setInterval(() => {
      void this.sweepAbandonedRuns().catch(
        swallow(this.logger, "sweep abandoned registered-host runs")
      );
    }, intervalMs);
    this.sweepTimer.unref();
  }

  private async sweepAbandonedRuns(): Promise<void> {
    const activeRuns = await this.runRepository.listActive();
    if (activeRuns.length === 0) return;
    const graceMs = this.configService.getHeartbeatTimeoutSeconds() * 2 * 1000;
    const cutoff = Date.now() - graceMs;
    // 同一台 Host 的行只查一次
    const hostStatus = new Map<string, boolean>();
    for (const run of activeRuns) {
      const runtimeHostId = run.conversation.workspace.runtimeHostId;
      if (isBuiltinHostId(runtimeHostId)) continue;
      let abandoned = hostStatus.get(runtimeHostId);
      if (abandoned === undefined) {
        abandoned = await this.hostAbandoned(runtimeHostId, cutoff);
        hostStatus.set(runtimeHostId, abandoned);
      }
      if (!abandoned) continue;
      this.logger.warn(
        `Run ${run.id} abandoned: registered host ${runtimeHostId} offline beyond grace window`
      );
      await this.failRun(
        run.id,
        run.conversationId,
        "Runtime Host 离线超时,运行中断"
      );
      this.runtimeHost.releaseRun({ runtimeHostId, runId: run.id });
    }
  }

  private async hostAbandoned(
    runtimeHostId: string,
    cutoffMs: number
  ): Promise<boolean> {
    const row = await this.runtimeService.getRuntimeHostRow(runtimeHostId);
    if (!row) return true; // Runtime 行不存在:无从续传,判死
    if (row.status === "online") return false;
    const heartbeatAt = row.lastHeartbeatAt?.getTime() ?? 0;
    return heartbeatAt < cutoffMs;
  }

  private async failRun(
    runId: string,
    conversationId: string,
    reason: string
  ): Promise<void> {
    await this.runRepository.markError(runId, reason);
    await this.conversationService
      .setConversationRunState(conversationId, { runStatus: "error" })
      .catch(
        swallow(
          this.logger,
          `set conversation active run status to error for run ${runId}`
        )
      );
  }
}
