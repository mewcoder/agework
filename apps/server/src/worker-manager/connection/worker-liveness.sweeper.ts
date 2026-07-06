import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { isRuntimeType, type RuntimeInstanceRef } from "@agework/providers";
import { ConfigService } from "../../config/config.service";
import { safeLogJson } from "../../common/logging";
import { swallow } from "../../common/swallow";
import { WorkerLivenessStore } from "./worker-liveness.store";
import { WorkerUpstreamRegistry } from "./worker-upstream.registry";
import { WorkerRegistryRepository } from "../registry/worker-registry.repository";
import { WorkerProvisioner } from "../instance/worker.provisioner";
import { OwnerRunStore } from "../instance/owner-run.store";

/**
 * 定时扫描 WorkerLivenessStore,把超过心跳超时阈值没见到 poll 的 owner 判定为
 * unhealthy 并 fence 掉它名下的 worker。超时即判死,不做"确认死亡"(卡死但进程
 * 没退出正是本机制要抓的场景)。直接依赖 registry/provisioner/upstream/
 * ownerRunStore 这些下层 internal provider 自己把 fence 动作做完,不反过来依赖
 * WorkerManagerService——与同样做心跳判死的 RuntimeLivenessWatchdog(直接依赖
 * RuntimeRepository,不依赖 RuntimeService)保持一致的写法。
 */
@Injectable()
export class WorkerLivenessSweeper
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(WorkerLivenessSweeper.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly livenessStore: WorkerLivenessStore,
    private readonly configService: ConfigService,
    private readonly registry: WorkerRegistryRepository,
    private readonly provisioner: WorkerProvisioner,
    private readonly upstream: WorkerUpstreamRegistry,
    private readonly ownerRunStore: OwnerRunStore
  ) {}

  onApplicationBootstrap(): void {
    const intervalMs =
      this.configService.getHeartbeatCheckIntervalSeconds() * 1000;
    this.timer = setInterval(() => {
      this.sweep();
    }, intervalMs);
    // unref 避免这个周期性 timer 阻止进程干净退出
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private sweep(): void {
    const timeoutMs = this.configService.getHeartbeatTimeoutSeconds() * 1000;
    const staleOwnerIds = this.livenessStore.listStale(timeoutMs, Date.now());
    for (const ownerId of staleOwnerIds) {
      this.fenceWorkerByOwnerId(ownerId, "worker heartbeat timeout").catch(
        swallow(this.logger, `fence owner ${ownerId}`)
      );
    }
  }

  /**
   * fence 掉某 owner 名下 unhealthy 的 worker:超时即判死,不做"确认死亡"(卡死但
   * 进程没退出正是本机制要抓的场景)。物理停止载体是幂等操作,对已经死透的容器/
   * 进程重复调用无害。找不到活跃行说明该 owner 已经被别的路径清理过,直接 return。
   */
  private async fenceWorkerByOwnerId(
    ownerId: string,
    reason: string
  ): Promise<void> {
    const active = await this.registry.findActiveByOwnerId(ownerId);
    if (!active) return;

    const runIds = this.ownerRunStore.runIdsForOwner(ownerId);
    for (const runId of runIds) {
      await this.upstream
        .notifyWorkerLost(runId, reason)
        .catch(swallow(this.logger, `notify worker lost for run ${runId}`));
    }

    await this.stopWorkerByOwnerId(ownerId);
    this.livenessStore.remove(ownerId);

    this.logger.warn(
      `fenced unhealthy owner ${safeLogJson({
        ownerId,
        reason,
        terminatedRuns: runIds.length,
      })}`
    );
  }

  /**
   * 停掉指定 owner 名下的 worker(owner 仍在):从 registry 取出该 owner 当前活跃行
   * (权威来源),按行内容构造 ref 交给 provisioner.stop(保留载体)。找不到活跃行
   * 说明已经被别的路径清理过,no-op。
   */
  private async stopWorkerByOwnerId(ownerId: string): Promise<void> {
    const row = await this.registry.findActiveByOwnerId(ownerId);
    if (!row) return;
    if (!isRuntimeType(row.runtimeType)) return;
    const ref: RuntimeInstanceRef = {
      runtimeType: row.runtimeType,
      ownerId: row.ownerId,
      runtimeInstanceId: row.instanceId,
      isolationScope: row.isolationScope,
      targetRuntimeId: row.runtimeId,
    };
    await this.provisioner.stop(ref);
  }
}
