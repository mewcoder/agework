import { WebSocket } from "ws";
import type {
  ExecutionRef,
  RunChannelMessage,
  RuntimeHostUpstream,
  HostUpstreamNotification,
} from "@agework/shared/protocol";

/**
 * RuntimeHostUpstream 的隧道实现：将 Host 的上行通知经 WebSocket 隧道
 * 以 `host.upstream` JSON-RPC notification 发给 server。
 *
 * WebSocket 连接由 TunnelClient 管理，重连后通过 `setSocket` 更新引用。
 * 连接断开期间通知静默丢弃——server 侧靠 ACK 水位 + 重连补发兜底，
 * 终态事实由 server 的 Host 判死路径兜底。
 */
export class TunnelUpstream implements RuntimeHostUpstream {
  private ws?: WebSocket;

  setSocket(ws: WebSocket | undefined): void {
    this.ws = ws;
  }

  async emit(runId: string, message: RunChannelMessage<unknown>): Promise<void> {
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

  notifyExecutionRef(runId: string, ref: ExecutionRef): void {
    this.send({ kind: "executionRef", runId, ref });
  }

  private send(notification: HostUpstreamNotification): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const message = {
      jsonrpc: "2.0" as const,
      method: "host.upstream" as const,
      params: notification,
    };
    this.ws.send(JSON.stringify(message));
  }
}
