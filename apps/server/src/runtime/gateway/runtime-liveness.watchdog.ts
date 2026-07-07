import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { ConfigService } from "../../config/config.service";
import { RuntimeRepository } from "../runtime.repository";

/**
 * Runtime 级判死:定时把 online 但心跳超时的 Runtime 行标记 offline。
 * 与 worker 级判死(WorkerLivenessSweeper,fence owner)分层——Runtime 掉线
 * 影响的是"这台机器还能不能接 launch";其上 worker 的判死仍走 worker 心跳。
 * 超时即判死,不做"确认死亡"。
 */
@Injectable()
export class RuntimeLivenessWatchdog
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(RuntimeLivenessWatchdog.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly repository: RuntimeRepository,
    private readonly configService: ConfigService
  ) {}

  onApplicationBootstrap(): void {
    const intervalMs =
      this.configService.getHeartbeatCheckIntervalSeconds() * 1000;
    this.timer = setInterval(() => {
      void this.sweep();
    }, intervalMs);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async sweep(): Promise<void> {
    const timeoutMs = this.configService.getHeartbeatTimeoutSeconds() * 1000;
    const cutoff = new Date(Date.now() - timeoutMs);
    try {
      const count = await this.repository.markStaleOnlineAsOffline(cutoff);
      if (count > 0) {
        this.logger.warn(`marked ${count} stale runtime(s) offline`);
      }
    } catch (err) {
      this.logger.warn(
        `runtime liveness sweep failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}
