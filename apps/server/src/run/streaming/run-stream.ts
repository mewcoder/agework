import type { Response } from "express";

type RunStreamMode = "events" | "snapshots";

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

  get isSnapshotMode(): boolean {
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
    if (!this.response || this.response.writableEnded) return;
    this.response.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  private setHeaders(response: Response): void {
    response.setHeader("Content-Type", "text/event-stream");
    response.setHeader("Cache-Control", "no-cache");
    response.setHeader("Connection", "keep-alive");
  }
}
