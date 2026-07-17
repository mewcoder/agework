import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { generateId } from "@agework/shared";
import type { RuntimeHostExecution } from "@agework/shared/protocol";
import { RunRepository } from "../run.repository";
import {
  RUNTIME_HOST_EXECUTION,
  RUNTIME_HOST_RUN_RECONCILIATION,
  RUNTIME_HOST_RUN_REAP_BINDING,
  type HostReapReason,
  type HostRunReapBinding,
  type HostRunReapPort,
  type RuntimeHostRunReconciliation,
} from "../../runtime-host/runtime-host.types";
import { ConversationService } from "../../conversation/conversation.service";
import { RuntimeHostService } from "../../runtime-host/runtime-host.service";
import { isBuiltinHostId } from "../../runtime-host/runtime-host.types";
import { ConfigService } from "../../config/config.service";
import { swallow } from "../../common/swallow";
import {
  RUNTIME_HOST_CONNECTED_EVENT,
  type RuntimeHostConnectedEvent,
} from "../../runtime-host/runtime-host.events";
import { isActiveRunStatus } from "../status/run-status.policy";

/** Host 终态收尾的日志措辞 + 写给用户的 run 失败原因,按触发场景取。 */
const REAP_MESSAGES: Record<
  HostReapReason,
  { logDetail: string; runReason: string }
> = {
  reincarnation: {
    logDetail: "replaced its process instance",
    runReason: "Runtime Host 重启(进程更替),运行中断",
  },
  shutdown: {
    logDetail: "announced graceful shutdown",
    runReason: "Runtime Host 已关停,运行中断",
  },
};

/**
 * 服务重启后恢复中断 run,按 Host 归属分流(Phase 2):
 * - builtin Host 与 server 同生共死,其上的 run 无法续接,启动时统一判死。
 * - registered Host 虽独立存活，但 server 重启后 LiveRunHandle、聚合器、SSE 与
 *   timeout 都已丢失，不能假装透明续传；同样判死，并尽力取消远端旧 run。
 *
 * 兜底:registered Host 一直不回来时,run 不能永远挂着——定时 sweep 把
 * 「绑定的 registered Host 已 offline 且心跳静默超过 2× 判死窗口」的 active run
 * 判死。这同时覆盖运行期整机失联(不只是 server 重启窗口)。
 */
@Injectable()
export class RunRecoveryService
  implements OnApplicationBootstrap, OnApplicationShutdown, HostRunReapPort
{
  private readonly logger = new Logger(RunRecoveryService.name);
  private sweepTimer?: NodeJS.Timeout;
  private readonly pendingHostReconciliations = new Set<string>();

  constructor(
    private readonly runRepository: RunRepository,
    private readonly conversationService: ConversationService,
    private readonly runtimeHostService: RuntimeHostService,
    private readonly configService: ConfigService,
    @Inject(RUNTIME_HOST_EXECUTION)
    private readonly runtimeHost: RuntimeHostExecution,
    @Inject(RUNTIME_HOST_RUN_RECONCILIATION)
    private readonly runReconciliation: RuntimeHostRunReconciliation,
    @Inject(RUNTIME_HOST_RUN_REAP_BINDING)
    private readonly runReapBinding: HostRunReapBinding
  ) {}

  /** 端口自接线:本类是 Host 终态收尾端口的实现者,启动期注册给隧道网关调用。 */
  onApplicationBootstrap(): void {
    this.runReapBinding.setRunReapPort(this);
  }

  onApplicationShutdown(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
    this.pendingHostReconciliations.clear();
  }

  async failInterruptedRuns(): Promise<void> {
    const activeRuns = await this.runRepository.listActive();
    if (activeRuns.length === 0) {
      this.logger.log("No interrupted active runs found.");
    } else {
      for (const run of activeRuns) {
        const runtimeHostId = run.conversation.workspace.runtimeHostId;
        await this.failRun(run.id, run.conversationId, "服务重启导致运行中断");
        this.logger.log(`Marked interrupted run ${run.id} as error`);

        if (isBuiltinHostId(runtimeHostId)) continue;
        await this.cleanupRemoteRun(
          runtimeHostId,
          run.id,
          run.conversationId
        ).catch((err: unknown) => {
          this.pendingHostReconciliations.add(runtimeHostId);
          this.logCleanupFailure(runtimeHostId, run.id, err);
        });
      }
    }
    this.startAbandonedSweep();
  }

  /** registered Host 重连后，以 Host 现场与数据库状态重新对账，不依赖本进程内存。 */
  @OnEvent(RUNTIME_HOST_CONNECTED_EVENT, { async: true })
  async onRuntimeHostConnected(
    event: RuntimeHostConnectedEvent
  ): Promise<void> {
    this.pendingHostReconciliations.add(event.runtimeHostId);
    await this.retryHostReconciliation(event.runtimeHostId);
  }

  private async retryHostReconciliation(runtimeHostId: string): Promise<void> {
    try {
      await this.reconcileHostRuns(runtimeHostId);
      this.pendingHostReconciliations.delete(runtimeHostId);
    } catch (err) {
      this.pendingHostReconciliations.add(runtimeHostId);
      this.logger.warn(
        `reconcile runs on runtime host ${runtimeHostId} failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private async reconcileHostRuns(runtimeHostId: string): Promise<void> {
    const runIds = await this.runReconciliation.listRunIds(runtimeHostId);
    const rows = await this.runRepository.findRuntimeReconciliationRows(runIds);
    const rowById = new Map(rows.map((row) => [row.id, row]));
    let firstFailure: Error | undefined;

    for (const runId of runIds) {
      const row = rowById.get(runId);
      if (row && isActiveRunStatus(row.status)) continue;
      if (!row) {
        this.logger.warn(
          `releasing unknown run ${runId} from runtime host ${runtimeHostId}`
        );
        this.runtimeHost.releaseRun({ runtimeHostId, runId });
        continue;
      }
      try {
        await this.cleanupRemoteRun(runtimeHostId, runId, row.conversationId);
      } catch (err) {
        firstFailure ??= err instanceof Error ? err : new Error(String(err));
        this.logCleanupFailure(runtimeHostId, runId, err);
      }
    }

    if (firstFailure) throw firstFailure;
  }

  private async cleanupRemoteRun(
    runtimeHostId: string,
    runId: string,
    conversationId: string
  ): Promise<void> {
    await this.runtimeHost.command({
      runtimeHostId,
      payload: {
        type: "cancel",
        commandId: generateId(),
        runId,
        conversationId,
      },
    });
    this.runtimeHost.releaseRun({ runtimeHostId, runId });
  }

  private logCleanupFailure(
    runtimeHostId: string,
    runId: string,
    err: unknown
  ): void {
    this.logger.warn(
      `cleanup interrupted run ${runId} on runtime host ${runtimeHostId} failed: ${err instanceof Error ? err.message : String(err)}`
    );
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
    await Promise.all(
      [...this.pendingHostReconciliations].map((runtimeHostId) =>
        this.retryHostReconciliation(runtimeHostId)
      )
    );
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

  /**
   * HostRunReapPort:registered Host 发生终态生命周期事件(进程更替 / 优雅关停)时
   * 由隧道网关同步调用。该 Host 上所有 active run 的旧会话/未 ACK 缓冲已随旧进程
   * 消失,确定性判死并释放执行机侧 run 状态,避免僵尸 run 永久挂 running。
   * 幂等:已终结的 run 不在 listActive 结果内。
   */
  async reapActiveRuns(
    runtimeHostId: string,
    reason: HostReapReason
  ): Promise<void> {
    const { logDetail, runReason } = REAP_MESSAGES[reason];
    const activeRuns = await this.runRepository.listActive();
    for (const run of activeRuns) {
      if (run.conversation.workspace.runtimeHostId !== runtimeHostId) continue;
      this.logger.warn(
        `Run ${run.id} reaped: host ${runtimeHostId} ${logDetail}`
      );
      await this.failRun(run.id, run.conversationId, runReason);
      this.runtimeHost.releaseRun({ runtimeHostId, runId: run.id });
    }
  }

  private async hostAbandoned(
    runtimeHostId: string,
    cutoffMs: number
  ): Promise<boolean> {
    const row = await this.runtimeHostService.getRuntimeHostRow(runtimeHostId);
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
