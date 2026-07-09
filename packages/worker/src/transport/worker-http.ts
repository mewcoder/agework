import type {
  RunConfig,
  CommandPayload,
  CommandResultPayload,
  RunChannelMessage,
  UpstreamMessage,
  WorkerCommandRpcRequest,
  WorkerRegisterRequest,
} from "@agework/shared/protocol";
import {
  WORKER_ID_HEADER,
  WORKER_TOKEN_HEADER,
} from "@agework/shared/protocol";
import {
  commandResultMessageToRpcResponse,
  isWorkerCommandRpcRequest,
  rpcRequestToCommandMessage,
  upstreamMessageToRpcNotification,
} from "@agework/shared/protocol/rpc";
import { AGEWORK_VERSION } from "@agework/shared";
import { errorDetails, workerLog } from "../logging/worker-log.js";

/**
 * 常驻 worker 的 worker-manager HTTP 客户端。
 * commands 轮询是 workerId 级（`/worker/:workerId/commands`，
 * workerId 由 env AGEWORK_WORKER_ID 传入），emit/fetchRunConfig 按 runId 参数化。
 */
const EMIT_RETRY_ATTEMPTS = 3;
const EMIT_RETRY_DELAYS_MS = [1_000, 2_000, 4_000];
export class WorkerHttpTransport {
  private readonly apiBase: string;
  private readonly workerId: string;
  private readonly token: string;
  private commandSeq = 0;
  private emptyPolls = 0;
  /** server 侧队列的代次标识，未定义表示还没见过任何 epoch（冷启动）。 */
  private queueEpoch: number | undefined;
  private readonly eventSeqs = new Map<string, number>();
  /** 按 runId 串行化 emit，避免并发 fetch 乱序到达导致服务端按 seq 去重时丢弃早序事件。 */
  private readonly emitChains = new Map<string, Promise<void>>();

  constructor() {
    this.apiBase = process.env.AGEWORK_WORKER_API_BASE ?? "http://localhost:3000";
    this.workerId = process.env.AGEWORK_WORKER_ID ?? "";
    this.token = process.env.AGEWORK_WORKER_START_TOKEN ?? "";

    if (!this.workerId) {
      throw new Error("AGEWORK_WORKER_ID is required for resident worker");
    }

    workerLog("worker-manager http client initialized", {
      apiBase: this.apiBase,
      workerId: this.workerId,
      logFile:
        process.env.AGEWORK_WORKER_LOG_FILE ??
        "/tmp/agework-worker.log",
    });
  }

  async pollCommands(waitMs = 0): Promise<{
    commands: RunChannelMessage<CommandPayload>[];
  }> {
    const commandsPath = `/worker/${this.workerId}/commands`;
    const params = new URLSearchParams({ afterSeq: String(this.commandSeq) });
    if (waitMs > 0) {
      params.set("waitMs", String(waitMs));
    }
    const url = `${this.apiBase}${commandsPath}?${params.toString()}`;
    let res: Response;
    try {
      res = await fetch(url, { headers: this.buildAuthHeaders() });
    } catch (err) {
      workerLog("command poll failed", {
        workerId: this.workerId,
        afterSeq: this.commandSeq,
        ...errorDetails(err),
      }, "warn");
      // 网络瞬时故障不崩溃，返回空让调用方重试
      return { commands: [] };
    }

    if (!res.ok) {
      const body = await safeText(res);
      workerLog("command poll returned non-ok", {
        workerId: this.workerId,
        afterSeq: this.commandSeq,
        status: res.status,
        body,
      }, res.status === 401 ? "error" : "warn");
      if (this.handleFatalResponse(res, { afterSeq: this.commandSeq })) {
        return { commands: [] };
      }
      if (res.status === 401) {
        workerLog("runtime access key invalid, exiting", {
          workerId: this.workerId,
        }, "error");
        process.exit(1);
      }
      return { commands: [] };
    }

    const data = (await res.json()) as {
      messages?: WorkerCommandRpcRequest[];
      queueEpoch?: number;
    };

    const previousEpoch = this.queueEpoch;
    if (data.queueEpoch !== undefined) {
      this.queueEpoch = data.queueEpoch;
    }
    if (
      previousEpoch !== undefined &&
      data.queueEpoch !== undefined &&
      data.queueEpoch !== previousEpoch
    ) {
      workerLog("queue epoch changed, resetting afterSeq and re-polling", {
        workerId: this.workerId,
        previousEpoch,
        newEpoch: data.queueEpoch,
      }, "warn");
      this.commandSeq = 0;
      // 本次响应已经是用过期的 afterSeq 请求出来的，服务端重启后新队列从 seq 1
      // 开始，这次 messages 大概率把新队列的命令全过滤掉了。用重置后的
      // afterSeq=0 立即重新拉取一次，把这次遗漏的命令找回来，调用方全程无感。
      return this.pollCommands(waitMs);
    }

    const commands = normalizeCommandPollResponse(data);
    if (commands.length > 0) {
      this.emptyPolls = 0;
      workerLog("command poll received commands", {
        workerId: this.workerId,
        afterSeq: this.commandSeq,
        count: commands.length,
        commands: commands.map((command) => ({
          seq: command.seq,
          runId: command.runId,
          type: command.payload.type,
          commandId: command.payload.commandId,
        })),
      }, "debug");
    } else {
      this.emptyPolls += 1;
      if (this.emptyPolls <= 3 || this.emptyPolls % 30 === 0) {
        workerLog("command poll empty", {
          workerId: this.workerId,
          afterSeq: this.commandSeq,
          emptyPolls: this.emptyPolls,
        }, "debug");
      }
    }
    for (const command of commands) {
      if (command.seq > this.commandSeq) {
        this.commandSeq = command.seq;
      }
    }
    return { commands };
  }

  async fetchRunConfig(runId: string): Promise<RunConfig> {
    workerLog("fetch run config", {
      runId,
      workerId: this.workerId,
    }, "debug");
    const res = await fetch(`${this.apiBase}/worker/runs/${runId}`, {
      headers: this.buildAuthHeaders(),
    });
    if (!res.ok) {
      const body = await safeText(res);
      workerLog("fetch run config returned non-ok", {
        runId,
        workerId: this.workerId,
        status: res.status,
        body,
      }, "warn");
      this.handleFatalResponse(res, { runId });
      throw new Error(`Failed to fetch run config: ${res.status} ${body}`);
    }
    const data = (await res.json()) as { config: RunConfig };
    workerLog("fetch run config ok", {
      runId,
      workerId: this.workerId,
      conversationId: data.config.conversationId,
      agentType: data.config.agentProviderConfig.agentType,
      runtimePath: data.config.runtimePath,
      agentProviderSource: data.config.agentProviderConfig.source,
    }, "debug");
    return data.config;
  }

  /**
   * 进入命令轮询循环前的注册握手:带上 launch 时下发的 startToken 证明自己是
   * server 期望的那个进程/容器,server 收到后才把该 worker 判定为 running。
   * 重试/兜底退出由调用方（worker.ts runWorker）负责。
   */
  async register(): Promise<void> {
    const url = `${this.apiBase}/worker/${this.workerId}/register`;
    const body: WorkerRegisterRequest = {
      startToken: process.env.AGEWORK_WORKER_START_TOKEN ?? "",
      pid: process.pid,
      version: AGEWORK_VERSION,
    };
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const responseBody = await safeText(res);
      throw new Error(`register failed: ${res.status} ${responseBody}`);
    }
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
    const url = `${this.apiBase}/worker/runs/${runId}/events`;
    const message = {
      ...msg,
      runId,
      seq: this.nextEventSeq(runId),
      ts: new Date().toISOString(),
    };
    const body = JSON.stringify(encodeUpstreamMessageForHttp(message));
    const summary = summarizeUpstreamMessage(message);
    if (shouldLogEmit(message)) {
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
            ...this.buildAuthHeaders(),
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

      if (this.handleFatalResponse(res, summary)) return;

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

  /** commands/runConfig/events 三个端点共用的鉴权 header。 */
  private buildAuthHeaders(): Record<string, string> {
    return {
      [WORKER_ID_HEADER]: this.workerId,
      [WORKER_TOKEN_HEADER]: this.token,
    };
  }

  /**
   * 410 = 该 worker 的 token 已被 server 判定为不再有效（比如已经被新的
   * worker 进程顶替），此时应直接退出进程，不重试、不重连。
   * 返回是否已经处理，调用方据此决定要不要继续走原来的重试/报错逻辑。
   */
  private handleFatalResponse(
    res: Response,
    context: Record<string, unknown>
  ): boolean {
    if (res.status !== 410) return false;
    workerLog("worker token evicted by server, exiting", {
      workerId: this.workerId,
      ...context,
    }, "error");
    process.exit(1);
    return true;
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

function normalizeCommandPollResponse(data: {
  messages?: WorkerCommandRpcRequest[];
}): RunChannelMessage<CommandPayload>[] {
  return (data.messages ?? [])
    .filter(isWorkerCommandRpcRequest)
    .map(rpcRequestToCommandMessage);
}

function encodeUpstreamMessageForHttp(msg: UpstreamMessage) {
  if (msg.type === "command.result") {
    return commandResultMessageToRpcResponse(
      msg as RunChannelMessage<CommandResultPayload>
    );
  }
  return upstreamMessageToRpcNotification(msg);
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
