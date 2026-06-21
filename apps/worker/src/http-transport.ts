import type {
  RuntimeTransport,
  RunConfig,
  UpstreamMessage,
  ControlPayload,
  Envelope,
  Unsubscribe,
} from "@agework/shared/protocol";
import { errorDetails, workerLog } from "./worker-log.js";

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_POLL_TIMEOUT_MS = 30_000;
const EVENT_RETRY_ATTEMPTS = 3;
const EVENT_RETRY_DELAYS_MS = [1_000, 2_000, 4_000];

/**
 * RuntimeTransport 的 HTTP 实现。
 * Worker 通过 POST /events 上报事件，GET /controls 轮询控制指令。
 * 用于 Docker / 远程 worker 场景。
 */
export class HttpTransport implements RuntimeTransport {
  private eventSeq = 0;
  private controlSeq = 0;
  private polling = true;
  /** 串行化 emit，避免并发 fetch 乱序到达导致服务端按 seq 去重时丢弃早序事件。 */
  private emitChain: Promise<void> = Promise.resolve();
  private readonly apiBase: string;
  private readonly runId: string;
  private readonly accessKey: string;

  constructor() {
    this.apiBase = process.env.AGEWORK_INTERNAL_API_BASE ?? "http://localhost:3000";
    this.runId = process.env.AGEWORK_INTERNAL_RUN_ID ?? "";
    this.accessKey = process.env.AGEWORK_INTERNAL_RUNTIME_ACCESS_KEY ?? "";

    if (!this.runId) {
      throw new Error("AGEWORK_INTERNAL_RUN_ID is required for HTTP transport");
    }
    if (!this.accessKey) {
      throw new Error("AGEWORK_INTERNAL_RUNTIME_ACCESS_KEY is required for HTTP transport");
    }
  }

  async fetchRunConfig(): Promise<RunConfig> {
    const res = await fetch(`${this.apiBase}/internal/runs/${this.runId}`, {
      headers: { Authorization: `Bearer ${this.accessKey}` },
    });
    if (!res.ok) {
      throw new Error(
        `Failed to fetch run config: ${res.status} ${await res.text()}`
      );
    }
    const data = (await res.json()) as { config: RunConfig };
    return data.config;
  }

  async emit(msg: UpstreamMessage): Promise<void> {
    const next = this.emitChain.then(() => this.doEmit(msg));
    this.emitChain = next.catch(() => {});
    return next;
  }

  private async doEmit(msg: UpstreamMessage): Promise<void> {
    const envelope = {
      ...msg,
      runId: this.runId,
      seq: ++this.eventSeq,
      ts: new Date().toISOString(),
    };

    let lastError: Error | undefined;
    for (let attempt = 0; attempt < EVENT_RETRY_ATTEMPTS; attempt++) {
      let res: Response;
      try {
        res = await fetch(
          `${this.apiBase}/internal/runs/${this.runId}/events`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${this.accessKey}`,
            },
            body: JSON.stringify(envelope),
          }
        );
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        workerLog("event post request failed", {
          runId: this.runId,
          seq: envelope.seq,
          type: envelope.type,
          source: "worker",
          eventType: "emit.retry",
          attempt: attempt + 1,
          ...errorDetails(err),
        }, "warn");
        if (attempt < EVENT_RETRY_ATTEMPTS - 1) {
          await sleep(EVENT_RETRY_DELAYS_MS[attempt] ?? 4_000);
        }
        continue;
      }

      if (res.ok) return;

      // 4xx = client error, don't retry
      if (res.status >= 400 && res.status < 500) {
        const body = await res.text();
        workerLog("event post returned client error", {
          runId: this.runId,
          seq: envelope.seq,
          type: envelope.type,
          source: "worker",
          eventType: "emit.failed",
          status: res.status,
          body,
        }, "error");
        throw new Error(`Event POST failed: ${res.status} ${body}`);
      }

      const body = await res.text();
      lastError = new Error(
        `Event POST failed: ${res.status} ${body}`
      );
      workerLog("event post returned retryable non-ok", {
        runId: this.runId,
        seq: envelope.seq,
        type: envelope.type,
        source: "worker",
        eventType: "emit.retry",
        attempt: attempt + 1,
        status: res.status,
        body,
      }, "warn");
      if (attempt < EVENT_RETRY_ATTEMPTS - 1) {
        await sleep(EVENT_RETRY_DELAYS_MS[attempt] ?? 4_000);
      }
    }
    throw lastError ?? new Error("Event POST failed after retries");
  }

  subscribeControls(
    cb: (control: Envelope<ControlPayload>) => void
  ): Unsubscribe {
    this.polling = true;
    this.pollLoop(cb).catch(() => {});
    return () => {
      this.polling = false;
    };
  }

  async close(): Promise<void> {
    this.polling = false;
  }

  private async pollLoop(
    cb: (control: Envelope<ControlPayload>) => void
  ): Promise<void> {
    while (this.polling) {
      try {
        const url = `${this.apiBase}/internal/runs/${this.runId}/controls?afterSeq=${this.controlSeq}`;
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${this.accessKey}` },
        });

        if (res.ok) {
          const data = (await res.json()) as {
            controls: Envelope<ControlPayload>[];
          };
          for (const control of data.controls) {
            if (control.seq > this.controlSeq) {
              this.controlSeq = control.seq;
            }
            cb(control);
          }
        } else if (res.status === 401) {
          workerLog("runtime access key invalid, exiting", {
            runId: this.runId,
          }, "error");
          process.exit(1);
        }
        // On error or empty, wait before next poll
      } catch (err) {
        workerLog("control poll error", {
          runId: this.runId,
          afterSeq: this.controlSeq,
          ...errorDetails(err),
        }, "warn");
      }

      // Short sleep between polls
      await sleep(DEFAULT_POLL_INTERVAL_MS);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
