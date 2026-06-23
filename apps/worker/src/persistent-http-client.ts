import type {
  RunConfig,
  ControlPayload,
  Envelope,
  UpstreamMessage,
} from "@agework/shared/protocol";
import { errorDetails, workerLog } from "./worker-log.js";

/**
 * 持久容器 worker 的 HTTP 客户端。
 * 与 `HttpTransport` 的区别：controls 轮询是 workspace 级
 * （`/internal/workspaces/:workspaceId/controls`），emit/fetchRunConfig 按 runId 参数化。
 */
const EMIT_RETRY_ATTEMPTS = 3;
const EMIT_RETRY_DELAYS_MS = [1_000, 2_000, 4_000];
export class PersistentHttpClient {
  private readonly apiBase: string;
  private readonly workspaceId: string;
  private readonly runtimeResourceId: string | undefined;
  private readonly accessKey: string;
  private controlSeq = 0;
  private emptyPolls = 0;
  private readonly eventSeqs = new Map<string, number>();
  /** 按 runId 串行化 emit，避免并发 fetch 乱序到达导致服务端按 seq 去重时丢弃早序事件。 */
  private readonly emitChains = new Map<string, Promise<void>>();

  constructor() {
    this.apiBase = process.env.AGEWORK_INTERNAL_API_BASE ?? "http://localhost:3000";
    this.workspaceId = process.env.AGEWORK_INTERNAL_WORKSPACE_ID ?? "";
    this.runtimeResourceId =
      process.env.AGEWORK_INTERNAL_RUNTIME_RESOURCE_ID || undefined;
    this.accessKey = process.env.AGEWORK_INTERNAL_RUNTIME_ACCESS_KEY ?? "";

    if (!this.workspaceId && !this.runtimeResourceId) {
      throw new Error("AGEWORK_INTERNAL_WORKSPACE_ID or AGEWORK_INTERNAL_RUNTIME_RESOURCE_ID is required for persistent worker");
    }
    if (!this.accessKey) {
      throw new Error("AGEWORK_INTERNAL_RUNTIME_ACCESS_KEY is required for persistent worker");
    }

    workerLog("persistent http client initialized", {
      apiBase: this.apiBase,
      workspaceId: this.workspaceId,
      runtimeResourceId: this.runtimeResourceId,
      accessKeyPresent: Boolean(this.accessKey),
      logFile:
        process.env.AGEWORK_INTERNAL_WORKER_LOG_FILE ??
        "/tmp/agework-worker.log",
    });
  }

  private get authHeaders() {
    return { Authorization: `Bearer ${this.accessKey}` };
  }

  async pollControls(waitMs = 0): Promise<Envelope<ControlPayload>[]> {
    const controlsPath = this.runtimeResourceId
      ? `/internal/runtimes/${this.runtimeResourceId}/controls`
      : `/internal/workspaces/${this.workspaceId}/controls`;
    const params = new URLSearchParams({ afterSeq: String(this.controlSeq) });
    if (waitMs > 0) {
      params.set("waitMs", String(waitMs));
    }
    const url = `${this.apiBase}${controlsPath}?${params.toString()}`;
    let res: Response;
    try {
      res = await fetch(url, { headers: this.authHeaders });
    } catch (err) {
      workerLog("control poll failed", {
        workspaceId: this.workspaceId,
        runtimeResourceId: this.runtimeResourceId,
        afterSeq: this.controlSeq,
        ...errorDetails(err),
      }, "warn");
      // 网络瞬时故障不崩溃，返回空让调用方重试
      return [];
    }

    if (!res.ok) {
      const body = await safeText(res);
      workerLog("control poll returned non-ok", {
        workspaceId: this.workspaceId,
        runtimeResourceId: this.runtimeResourceId,
        afterSeq: this.controlSeq,
        status: res.status,
        body,
      }, res.status === 401 ? "error" : "warn");
      if (res.status === 401) {
        workerLog("runtime access key invalid, exiting", {
          workspaceId: this.workspaceId,
          runtimeResourceId: this.runtimeResourceId,
        }, "error");
        process.exit(1);
      }
      return [];
    }

    const data = (await res.json()) as { controls: Envelope<ControlPayload>[] };
    if (data.controls.length > 0) {
      this.emptyPolls = 0;
      workerLog("control poll received controls", {
        workspaceId: this.workspaceId,
        runtimeResourceId: this.runtimeResourceId,
        afterSeq: this.controlSeq,
        count: data.controls.length,
        controls: data.controls.map((control) => ({
          seq: control.seq,
          runId: control.runId,
          type: control.payload.type,
          commandId: control.payload.commandId,
        })),
      }, "debug");
    } else {
      this.emptyPolls += 1;
      if (this.emptyPolls <= 3 || this.emptyPolls % 30 === 0) {
        workerLog("control poll empty", {
          workspaceId: this.workspaceId,
          runtimeResourceId: this.runtimeResourceId,
          afterSeq: this.controlSeq,
          emptyPolls: this.emptyPolls,
        }, "debug");
      }
    }
    for (const control of data.controls) {
      if (control.seq > this.controlSeq) {
        this.controlSeq = control.seq;
      }
    }
    return data.controls;
  }

  async fetchRunConfig(runId: string): Promise<RunConfig> {
    workerLog("fetch run config", {
      runId,
      workspaceId: this.workspaceId,
      runtimeResourceId: this.runtimeResourceId,
    }, "debug");
    const res = await fetch(`${this.apiBase}/internal/runs/${runId}`, {
      headers: this.authHeaders,
    });
    if (!res.ok) {
      const body = await safeText(res);
      workerLog("fetch run config returned non-ok", {
        runId,
        workspaceId: this.workspaceId,
        status: res.status,
        body,
      }, "warn");
      throw new Error(`Failed to fetch run config: ${res.status} ${body}`);
    }
    const data = (await res.json()) as { config: RunConfig };
    workerLog("fetch run config ok", {
      runId,
      workspaceId: this.workspaceId,
      conversationId: data.config.conversationId,
      agentType: data.config.agentProviderConfig.agentType,
      runtimePath: data.config.runtimePath,
      agentProviderSource: data.config.agentProviderConfig.source,
    }, "debug");
    return data.config;
  }

  async emit(runId: string, msg: UpstreamMessage): Promise<void> {
    const prev = this.emitChains.get(runId) ?? Promise.resolve();
    const next = prev.then(() => this.doEmit(runId, msg));
    this.emitChains.set(
      runId,
      next.catch(() => {})
    );
    return next;
  }

  private async doEmit(runId: string, msg: UpstreamMessage): Promise<void> {
    const url = `${this.apiBase}/internal/runs/${runId}/events`;
    const envelope = {
      ...msg,
      runId,
      seq: this.nextEventSeq(runId),
      ts: new Date().toISOString(),
    };
    const body = JSON.stringify(envelope);
    const summary = summarizeUpstreamMessage(envelope);
    if (shouldLogEmit(envelope)) {
      workerLog("emit event", summary, "debug");
    }
    let lastError: Error | undefined;
    for (let attempt = 0; attempt < EMIT_RETRY_ATTEMPTS; attempt++) {
      let res: Response;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...this.authHeaders,
          },
          body,
        });
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        workerLog("emit event request failed", {
          ...summary,
          source: "worker",
          eventType: "emit.retry",
          attempt: attempt + 1,
          ...errorDetails(err),
        }, "warn");
        if (attempt < EMIT_RETRY_ATTEMPTS - 1) {
          await sleep(EMIT_RETRY_DELAYS_MS[attempt] ?? 4_000);
        }
        continue;
      }

      if (res.ok) return;

      // 4xx = client error, don't retry. 服务端已拒绝，事件会永久丢失，提级为 error 以保证可见。
      if (res.status >= 400 && res.status < 500) {
        const responseBody = await safeText(res);
        workerLog("emit event returned client error", {
          ...summary,
          source: "worker",
          eventType: "emit.failed",
          attempt: attempt + 1,
          status: res.status,
          body: responseBody,
        }, "error");
        throw new Error(`Event POST failed: ${res.status} ${responseBody}`);
      }

      const responseBody = await safeText(res);
      lastError = new Error(`Event POST failed: ${res.status} ${responseBody}`);
      workerLog("emit event returned retryable non-ok", {
        ...summary,
        source: "worker",
        eventType: "emit.retry",
        attempt: attempt + 1,
        status: res.status,
        body: responseBody,
      }, "warn");
      if (attempt < EMIT_RETRY_ATTEMPTS - 1) {
        await sleep(EMIT_RETRY_DELAYS_MS[attempt] ?? 4_000);
      }
    }
    workerLog("emit event failed after retries", {
      ...summary,
      source: "worker",
      eventType: "emit.failed",
      attempts: EMIT_RETRY_ATTEMPTS,
      error: lastError?.message,
    }, "error");
    throw lastError ?? new Error("Event POST failed after retries");
  }

  async emitWorkspaceHeartbeat(): Promise<void> {
    const heartbeatPath = this.runtimeResourceId
      ? `/internal/runtimes/${this.runtimeResourceId}/heartbeat`
      : `/internal/workspaces/${this.workspaceId}/heartbeat`;
    const res = await fetch(`${this.apiBase}${heartbeatPath}`, {
      method: "POST",
      headers: this.authHeaders,
    }).catch((err) => {
      workerLog("workspace heartbeat failed", {
        workspaceId: this.workspaceId,
        runtimeResourceId: this.runtimeResourceId,
        ...errorDetails(err),
      }, "warn");
      return undefined;
    });
    if (res && !res.ok) {
      workerLog("workspace heartbeat returned non-ok", {
        workspaceId: this.workspaceId,
        runtimeResourceId: this.runtimeResourceId,
        status: res.status,
        body: await safeText(res),
      }, "warn");
    }
  }

  private nextEventSeq(runId: string): number {
    const seq = (this.eventSeqs.get(runId) ?? 0) + 1;
    this.eventSeqs.set(runId, seq);
    return seq;
  }

  /**
   * 释放某个 run 在持久 worker 生命周期内的内存槽位（seq 计数器与 emit 串行链）。
   * run 完成后调用，避免长期运行的 worker 随 run 数量累积 Map 条目。
   * emitChains 的 Promise 此时已 settle，删除条目不影响进行中的 emit。
   */
  cleanup(runId: string): void {
    this.eventSeqs.delete(runId);
    this.emitChains.delete(runId);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

function summarizeUpstreamMessage(msg: UpstreamMessage) {
  const payload = msg.payload as Record<string, unknown> | undefined;
  return {
    runId: msg.runId,
    seq: msg.seq,
    type: msg.type,
    payloadType: typeof payload?.type === "string" ? payload.type : undefined,
    status: typeof payload?.status === "string" ? payload.status : undefined,
  };
}

function shouldLogEmit(msg: UpstreamMessage): boolean {
  if (msg.type !== "agui.event") return true;
  const payload = msg.payload as Record<string, unknown> | undefined;
  const eventType = payload?.type;
  return (
    typeof eventType === "string" &&
    (eventType.endsWith("_START") ||
      eventType.endsWith("_END") ||
      eventType === "RUN_STARTED" ||
      eventType === "RUN_ERROR")
  );
}
