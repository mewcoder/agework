import type {
  RunConfig,
  CommandPayload,
  RunChannelMessage,
  UpstreamMessage,
  UpstreamMessageInput,
  WorkerCommandRpcRequest,
  WorkerRegisterRequest,
} from "@agework/shared/protocol";
import {
  RUNTIME_WORKER_HTTP_PROTOCOL_VERSION,
  WORKER_ID_HEADER,
  WORKER_TOKEN_HEADER,
} from "@agework/shared/protocol";
import {
  encodeUpstreamMessageToWire,
  isWorkerCommandRpcRequest,
  rpcRequestToCommandMessage,
} from "@agework/shared/protocol/rpc";
import { AGEWORK_VERSION } from "@agework/shared";
import { errorDetails, workerLog } from "../logging/worker-log.js";

/**
 * 常驻 worker 的 Runtime Host HTTP 客户端。
 * commands 轮询是 workerId 级（`/worker/:workerId/commands`，
 * workerId 由 env AGEWORK_WORKER_ID 传入），emit/fetchRunConfig 按 runId 参数化。
 */
const EMIT_RETRY_ATTEMPTS = 3;
const EMIT_RETRY_DELAYS_MS = [1_000, 2_000, 4_000];
/**
 * 单次 fetch 的客户端超时。连接被黑洞(NAT 回收 / LB 空闲剔除 / 半开 socket)时,
 * 裸 fetch 不会报错,只挂着靠 undici 分钟级默认超时才醒——对控制面轮询和逐事件
 * emit 这种关键路径太粗。这里强制在超时后 abort,让上层走各自的重试 / 重连。
 */
const EMIT_TIMEOUT_MS = 10_000;
const RUN_CONFIG_TIMEOUT_MS = 10_000;
const REGISTER_TIMEOUT_MS = 10_000;
/** long-poll 客户端超时 = 服务端等待窗口 + 余量,保证正常挂起不被误伤。 */
const POLL_TIMEOUT_MARGIN_MS = 10_000;

type EmitWaiter = { resolve: () => void; reject: (err: unknown) => void };
/** 单个 runId 的上行发送状态:待发队列 + 对应 waiter + 是否已有 flush 循环在跑。 */
type EmitState = {
  queue: unknown[];
  waiters: EmitWaiter[];
  loop?: Promise<void>;
};
export class WorkerHttpTransport {
  private readonly apiBase: string;
  private readonly workerId: string;
  private readonly token: string;
  private commandSeq = 0;
  private emptyPolls = 0;
  /** server 侧队列的代次标识，未定义表示还没见过任何 epoch（冷启动）。 */
  private queueEpoch: number | undefined;
  private readonly eventSeqs = new Map<string, number>();
  /**
   * 按 runId 聚合上行事件。同一时刻每个 runId 最多一个 POST 在飞,期间到达的事件
   * 累积成下一批一起发。低负载(如 loopback)下每批只有 1 条=退化为单事件直发、不加
   * 延迟;只有事件产出快过 POST 往返时才自然成批,减少请求数。单 POST 在飞也保住了
   * 原来的顺序保证(服务端按 seq 去重不会丢早序事件)。
   */
  private readonly emitStates = new Map<string, EmitState>();

  constructor() {
    // 数据面对端是 Host 的 worker HTTP(由 provider 注入),server 上没有
    // 兜底端点——缺配置直接 fail fast,不做指向错误对象的默认值。
    const apiBase = process.env.AGEWORK_WORKER_API_BASE;
    if (!apiBase) {
      throw new Error("AGEWORK_WORKER_API_BASE is required for resident worker");
    }
    this.apiBase = apiBase;
    this.workerId = process.env.AGEWORK_WORKER_ID ?? "";
    this.token = process.env.AGEWORK_WORKER_START_TOKEN ?? "";

    if (!this.workerId) {
      throw new Error("AGEWORK_WORKER_ID is required for resident worker");
    }

    workerLog("runtime-host http client initialized", {
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
      res = await fetchWithTimeout(
        url,
        { headers: this.buildAuthHeaders() },
        (waitMs > 0 ? waitMs : 0) + POLL_TIMEOUT_MARGIN_MS
      );
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
    const res = await fetchWithTimeout(
      `${this.apiBase}/worker/runs/${runId}`,
      { headers: this.buildAuthHeaders() },
      RUN_CONFIG_TIMEOUT_MS
    );
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
   * Host 期望的那个进程/容器,Host 收到后才把该 worker 判定为 running。
   * 重试/兜底退出由调用方（worker.ts runWorker）负责。
   */
  async register(): Promise<void> {
    const url = `${this.apiBase}/worker/${this.workerId}/register`;
    const body: WorkerRegisterRequest = {
      startToken: process.env.AGEWORK_WORKER_START_TOKEN ?? "",
      pid: process.pid,
      protocolVersion: RUNTIME_WORKER_HTTP_PROTOCOL_VERSION,
      version: AGEWORK_VERSION,
    };
    const res = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      REGISTER_TIMEOUT_MS
    );
    if (!res.ok) {
      const responseBody = await safeText(res);
      throw new Error(`register failed: ${res.status} ${responseBody}`);
    }
  }

  async emit(runId: string, msg: UpstreamMessageInput): Promise<void> {
    const message = {
      ...msg,
      runId,
      seq: this.nextEventSeq(runId),
      ts: new Date().toISOString(),
    } as UpstreamMessage;
    if (shouldLogEmit(message)) {
      workerLog("emit event", summarizeUpstreamMessage(message), "debug");
    }
    let state = this.emitStates.get(runId);
    if (!state) {
      state = { queue: [], waiters: [] };
      this.emitStates.set(runId, state);
    }
    state.queue.push(encodeUpstreamMessageToWire(message));
    const settled = new Promise<void>((resolve, reject) => {
      state!.waiters.push({ resolve, reject });
    });
    // flush 循环自驱动;emit 返回的是本条事件所在批次的结果 promise。
    state.loop ??= this.flushLoop(runId);
    return settled;
  }

  /**
   * 单 runId 的 flush 循环:每轮取走当前全部待发事件发一批,POST 期间新到的事件
   * 进下一轮。批内所有 waiter 随该批 POST 结果一起 resolve/reject——保持与原逐事件
   * emit 相同的成功/失败语义,只是把多条合并成一次请求。
   */
  private async flushLoop(runId: string): Promise<void> {
    for (;;) {
      const state = this.emitStates.get(runId);
      if (!state || state.queue.length === 0) {
        this.emitStates.delete(runId);
        return;
      }
      const batch = state.queue.splice(0, state.queue.length);
      const waiters = state.waiters.splice(0, state.waiters.length);
      try {
        await this.postBatch(runId, batch);
        for (const waiter of waiters) waiter.resolve();
      } catch (err) {
        for (const waiter of waiters) waiter.reject(err);
      }
    }
  }

  /** 发送一批上行事件。批内 1 条时退化为单对象(与旧线格式一致),>1 条时发数组。 */
  private async postBatch(runId: string, batch: unknown[]): Promise<void> {
    const url = `${this.apiBase}/worker/runs/${runId}/events`;
    const body = JSON.stringify(batch.length === 1 ? batch[0] : batch);
    const summary = { runId, count: batch.length };
    let lastError: Error | undefined;
    for (let attempt = 0; attempt < EMIT_RETRY_ATTEMPTS; attempt++) {
      let res: Response;
      try {
        res = await fetchWithTimeout(
          url,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...this.buildAuthHeaders(),
            },
            body,
          },
          EMIT_TIMEOUT_MS
        );
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
   * token 已被 server 判定为不再有效,直接退出进程,不重试、不重连——由容器编排层
   * 决定是否重新拉起。commands 轮询、fetchRunConfig、事件上行三条路径共用同一判定,
   * 避免同一种凭证失效在不同端点上恢复语义不一致。
   * - 410 = token 已被顶替/驱逐(比如被新的 worker 进程接管)。
   * - 401 = token 被拒(缺失/错误/过期)。静态 startToken 不存在瞬时 401,重试无意义。
   * 返回是否已处理,调用方据此决定要不要继续走原来的重试/报错逻辑。
   */
  private handleFatalResponse(
    res: Response,
    context: Record<string, unknown>
  ): boolean {
    if (res.status !== 410 && res.status !== 401) return false;
    workerLog(
      res.status === 401
        ? "worker token rejected by server, exiting"
        : "worker token evicted by server, exiting",
      {
        workerId: this.workerId,
        status: res.status,
        ...context,
      },
      "error"
    );
    process.exit(1);
    return true;
  }

  private nextEventSeq(runId: string): number {
    const seq = (this.eventSeqs.get(runId) ?? 0) + 1;
    this.eventSeqs.set(runId, seq);
    return seq;
  }

  /**
   * 释放某个 run 在持久 worker 生命周期内的内存槽位（seq 计数器与 emit 批次状态）。
   * run 完成后调用，避免长期运行的 worker 随 run 数量累积 Map 条目。
   * 终态事件已 emit 且其批次 POST 已 settle（flush 循环随之排空并自删），此时删除
   * 残留条目不影响任何进行中的 emit。
   */
  cleanup(runId: string): void {
    this.eventSeqs.delete(runId);
    this.emitStates.delete(runId);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 给 fetch 套客户端超时:超时即 abort,fetch 抛错走上层重试 / 重连逻辑。
 * timer 在 fetch settle 后立即清除,不拖住事件循环。
 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
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
