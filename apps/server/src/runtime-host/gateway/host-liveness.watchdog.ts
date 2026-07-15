import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { ConfigService } from "../../config/config.service";
import { RuntimeHostRepository } from "../runtime-host.repository";
import { HostTunnelHandler } from "./host-tunnel.handler";

/**
 * Runtime 级判死:定时把 online 但心跳超时的 Runtime 行标记 offline。
 * 与 worker 级判死(WorkerLivenessSweeper,fence owner)分层——Runtime 掉线
 * 影响的是"这台机器还能不能接 launch";其上 worker 的判死仍走 worker 心跳。
 * 超时即判死,不做"确认死亡"。
 */
@Injectable()
export class HostLivenessWatchdog
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(HostLivenessWatchdog.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly repository: RuntimeHostRepository,
    private readonly configService: ConfigService,
    private readonly tunnelHandler: HostTunnelHandler
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
      const staleIds = await this.repository.markStaleOnlineAsOffline(cutoff);
      if (staleIds.length > 0) {
        // 判死同时回收内存里的半开连接:否则 isConnected() 仍为 true,run 派发
        // 会把 RPC 发到僵尸 socket 上干等超时,DB 与内存两个真相打架。
        for (const id of staleIds) {
          this.tunnelHandler.reapConnection(id);
        }
        this.logger.warn(`marked ${staleIds.length} stale runtime(s) offline`);
      }
    } catch (err) {
      this.logger.warn(
        `runtime liveness sweep failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}
