import { WebSocket } from "ws";
import type {
  RunChannelMessage,
  RuntimeHostUpstream,
  HostUpstreamNotification,
  HostUpstreamEnvelope,
} from "@agework/shared/protocol";

/** 未 ACK 缓冲上限。溢出时先丢最旧的中间事件(agui 流可断档),
 *  终态事实(runFailed/runCancelled/workerLost 与 run.status)永不丢——
 *  聊天流断档可由 runner raw jsonl 事后补查,run 生死真相不能丢(设计 §8-6)。 */
const MAX_BUFFERED = 5000;

type BufferedEntry = {
  seq: number;
  notification: HostUpstreamNotification;
};

/**
 * RuntimeHostUpstream 的隧道实现:将 Host 的上行通知经 WebSocket 隧道
 * 以 `host.upstream` JSON-RPC notification 发给 server。
 *
 * 可靠性(Phase 2 ACK 水位):每条通知带 Host 进程内单调递增 seq 入缓冲,
 * server 逐条回 `host.upstreamAck`(累计水位),收到后丢弃 ≤seq 的缓冲。
 * 断线期间只入缓冲不发送;重连完成注册(收到 registered + 新 epoch)后由
 * TunnelClient 调 `setSession` 接线,此时按原 seq 把缓冲全量补发。
 * server 重启丢失水位后的重复投递由 RunChannelMessage.seq 的 run 级幂等兜底。
 */
export class TunnelUpstream implements RuntimeHostUpstream {
  private ws?: WebSocket;
  private epoch?: number;
  private seq = 0;
  private buffer: BufferedEntry[] = [];

  /** 注册完成后接线:绑定新连接与会话 epoch,并补发全部未 ACK 通知。 */
  setSession(ws: WebSocket, epoch: number | undefined): void {
    this.ws = ws;
    this.epoch = epoch;
    for (const entry of this.buffer) {
      this.write(entry);
    }
  }

  /** 连接断开:停止发送,后续通知只入缓冲等重连补发。 */
  clearSocket(): void {
    this.ws = undefined;
  }

  /** server 的累计 ACK 水位:≤seq 的通知已被接收,丢弃对应缓冲。 */
  onAck(seq: number): void {
    this.buffer = this.buffer.filter((entry) => entry.seq > seq);
  }

  /** 测试观测:当前未 ACK 的缓冲数量。 */
  bufferedCount(): number {
    return this.buffer.length;
  }

  async emit(
    runId: string,
    message: RunChannelMessage<unknown>
  ): Promise<void> {
    this.send({ kind: "emit", runId, message });
  }

  async notifyRunFailed(runId: string, error: string): Promise<void> {
    this.send({ kind: "runFailed", runId, error });
  }

  async notifyRunCancelled(runId: string): Promise<void> {
    this.send({ kind: "runCancelled", runId });
  }

  async notifyWorkerLost(runId: string, reason: string): Promise<void> {
    this.send({ kind: "workerLost", runId, reason });
  }

  private send(notification: HostUpstreamNotification): void {
    const entry: BufferedEntry = { seq: ++this.seq, notification };
    this.buffer.push(entry);
    this.trimBuffer();
    this.write(entry);
  }

  private write(entry: BufferedEntry): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const envelope: HostUpstreamEnvelope = {
      seq: entry.seq,
      epoch: this.epoch,
      notification: entry.notification,
    };
    const message = {
      jsonrpc: "2.0" as const,
      method: "host.upstream" as const,
      params: envelope,
    };
    this.ws.send(JSON.stringify(message));
  }

  private trimBuffer(): void {
    while (this.buffer.length > MAX_BUFFERED) {
      const idx = this.buffer.findIndex(isDroppable);
      if (idx < 0) {
        // 全是终态事实还塞爆了(异常场景):只能丢最旧的,保住最新真相
        this.buffer.shift();
        continue;
      }
      this.buffer.splice(idx, 1);
    }
  }
}

/** 可丢弃 = 中间事件(emit 且不是 run.status 终态)。 */
function isDroppable(entry: BufferedEntry): boolean {
  return (
    entry.notification.kind === "emit" &&
    entry.notification.message.type !== "run.status"
  );
}
