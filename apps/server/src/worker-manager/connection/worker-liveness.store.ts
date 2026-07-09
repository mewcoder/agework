import { Injectable } from "@nestjs/common";

/**
 * 纯内存的 worker 心跳追踪:只认识"上次被看见的时间",不认识 poll/WS 等具体信号
 * 来源——touch() 调用点是 WorkerManagerService.pollCommands(长轮询本身就是心跳)
 * 和 postEvent(上报事件也是活着的证据),为将来 WS 场景留的接缝也是同一个 touch()
 * 入口。
 *
 * listStale 只看已经存在的条目,不主动假设"没见过 = 早就该判死"——一个 workerId
 * 在从未被 touch() 过之前不会出现在 listStale 的结果里。这个不变式同时兜住两种
 * 场景:新启动的 worker 还没来得及第一次 poll 就被 watchdog 扫到、以及 server
 * 重启后旧条目全部清空不会被误判为 stale。
 */
@Injectable()
export class WorkerLivenessStore {
  private readonly seenAt = new Map<string, number>();

  touch(workerId: string): void {
    this.seenAt.set(workerId, Date.now());
  }

  lastSeenAt(workerId: string): number | undefined {
    return this.seenAt.get(workerId);
  }

  remove(workerId: string): void {
    this.seenAt.delete(workerId);
  }

  listStale(thresholdMs: number, now: number): string[] {
    const cutoff = now - thresholdMs;
    const stale: string[] = [];
    for (const [workerId, seenAt] of this.seenAt) {
      if (seenAt < cutoff) stale.push(workerId);
    }
    return stale;
  }
}
