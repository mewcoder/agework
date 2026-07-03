import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { ConfigService } from "../../config/config.service";
import { swallow } from "../../common/swallow";
import { WorkerLivenessStore } from "./worker-liveness.store";
import { WorkerManagerService } from "../worker-manager.service";

/**
 * 定时扫描 WorkerLivenessStore,把超过心跳超时阈值没见到 poll 的 owner 判定为
 * unhealthy 并 fence。超时即判死,不做"确认死亡"(卡死但进程没退出正是本机制
 * 要抓的场景),fenceOwner 内部的物理停止动作本身是幂等的。
 */
@Injectable()
export class WorkerLivenessWatchdog
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(WorkerLivenessWatchdog.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly livenessStore: WorkerLivenessStore,
    private readonly configService: ConfigService,
    private readonly workerManager: WorkerManagerService
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
      this.workerManager
        .fenceOwner(ownerId, "worker heartbeat timeout")
        .catch(swallow(this.logger, `fence owner ${ownerId}`));
    }
  }
}
