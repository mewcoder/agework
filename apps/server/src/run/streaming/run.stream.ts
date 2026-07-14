import type { Response } from "express";

type RunStreamMode = "events" | "snapshots";

/**
 * 单条 SSE 连接的发送缓冲上限。连着但读得慢的客户端(卡死 / 被节流的标签页)会让
 * Node 无限缓冲在内存里。超过这个上限就主动断开该连接——run 仍在服务端聚合,客户端
 * 可经 /agent/resume 续接拿到完整快照,不丢数据。
 */
const MAX_SSE_BUFFERED_BYTES = 8 * 1024 * 1024;

export type RunSnapshotPayload = {
  content: unknown[];
  status: unknown;
  metadata?: unknown;
};

export class RunStream {
  private response: Response | null;
  private mode: RunStreamMode;

  constructor(response: Response, mode: RunStreamMode = "events") {
    this.response = response;
    this.mode = mode;
    this.setHeaders(response);
  }

  get snapshotMode(): boolean {
    return this.mode === "snapshots";
  }

  replace(response: Response, mode: RunStreamMode): void {
    this.end();
    this.response = response;
    this.mode = mode;
    this.setHeaders(response);
  }

  setStatus(status: number): void {
    this.response?.status(status);
  }

  onClose(callback: () => void): void {
    this.response?.on("close", callback);
  }

  isAttachedTo(response: Response): boolean {
    return this.response === response;
  }

  detach(response?: Response): void {
    if (response && this.response !== response) return;
    this.response = null;
    this.mode = "events";
  }

  writeEvent(event: unknown): void {
    this.writeData(event);
  }

  /** 只把 content/status/metadata 三个字段写上 SSE:调用方可直接传
   *  aggregator.build() 的完整快照,messageId 等持久化专用字段不上行。 */
  writeSnapshot(snapshot: RunSnapshotPayload): void {
    this.writeData({
      content: snapshot.content,
      status: snapshot.status,
      ...(snapshot.metadata !== undefined
        ? { metadata: snapshot.metadata }
        : {}),
    });
  }

  writeError(input: {
    threadId: string;
    runId: string;
    message: string;
  }): void {
    this.writeEvent({ type: "RUN_ERROR", ...input });
  }

  end(): void {
    if (!this.response || this.response.writableEnded) return;
    this.response.end();
  }

  private writeData(data: unknown): void {
    const res = this.response;
    if (!res || res.writableEnded) return;
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    // 背压保护:慢客户端把发送缓冲堆过上限时断开,交给 onClose→detach 收尾,
    // 保护 server 内存;run 不受影响,客户端可 resume 续接。
    if (res.writableLength > MAX_SSE_BUFFERED_BYTES) {
      res.end();
    }
  }

  private setHeaders(response: Response): void {
    response.setHeader("Content-Type", "text/event-stream");
    response.setHeader("Cache-Control", "no-cache");
    response.setHeader("Connection", "keep-alive");
  }
}
