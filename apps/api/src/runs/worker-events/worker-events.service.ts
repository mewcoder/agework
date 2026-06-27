import { Injectable, Logger } from "@nestjs/common";
import type {
  RunChannelMessage,
  RunStatusPayload,
  CommandResultPayload,
  CommandTracePayload,
  WorkerExecutionHandle,
  RecordRunEventInput,
} from "@agework/shared/protocol";
import type { RunEventReceiver } from "../execution/executor";
import type { WorkerUpstreamReceiver } from "../../worker-host/worker-upstream.registry";
import {
  LiveRunRegistry,
  type RunTimeoutErrorSink,
} from "../live-runs/live-run.registry";
import { ExecutionService } from "../execution/execution.service";
import {
  safeLogJson,
} from "../../common/logging";
import { swallow } from "../../common/swallow";
import { summarizeMessagePayload } from "./message-payload-summary";
import {
  decideRunStatusUpdate,
  TERMINAL_RUN_STATUSES,
} from "../status/run-status.policy";
import { RunStatusService } from "../status/run-status.service";
import { RunEventService } from "../../run-events/run-event.service";
import { WorkerAgUiEventHandler } from "./agui-event.handler";

/** 终态完成后保留记录的时长，用于阻止 exit handler 等延迟事件覆盖已终态 */
const COMPLETED_RUN_TTL_MS = 5 * 60 * 1000;

@Injectable()
export class WorkerEventsService
  implements RunEventReceiver, WorkerUpstreamReceiver, RunTimeoutErrorSink
{
  private readonly logger = new Logger(WorkerEventsService.name);
  private readonly lastSeqMap = new Map<string, number>();
  /** 防止同一 run 被并发处理多次终态 */
  private readonly finalizingRuns = new Set<string>();
  /** 已完成终态的 run，TTL 后自动清除，用于阻止 exit handler 覆盖 */
  private readonly completedRuns = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly liveRuns: LiveRunRegistry,
    private readonly runEvents: RunEventService,
    private readonly runStatusService: RunStatusService,
    private readonly executionService: ExecutionService,
    private readonly aguiEvents: WorkerAgUiEventHandler
  ) {}

  async sendEvent(
    runId: string,
    message: RunChannelMessage<unknown>
  ): Promise<void> {
    this.logger.debug(
      `worker event received ${safeLogJson({
        runId,
        messageRunId: message.runId,
        seq: message.seq,
        type: message.type,
        payload: summarizeMessagePayload(message.payload),
      })}`
    );

    // 先取出 handle：终态处理会 unregister，之后就拿不到 runtimeType 了。
    const handle = this.liveRuns.get(runId);

    await this.publish(message).catch((err) => {
      this.logger.warn(
        `WorkerEventsService.publish failed for runId=${runId}: ${String(err)}`
      );
    });

    if (message.type === "run.status") {
      const { status } = message.payload as RunStatusPayload;
      if (TERMINAL_RUN_STATUSES.includes(status) && handle) {
        this.executionService.cleanup(handle.runtimeHandle);
      }
    }
  }

  async notifyWorkerError(runId: string, error: string): Promise<void> {
    if (this.isTerminalOrFinalizing(runId)) return;
    await this.forceErrorStatus(runId, error);
  }

  async notifyCancelledBeforeReady(runId: string): Promise<void> {
    if (this.isTerminalOrFinalizing(runId)) return;
    await this.forceCancelledStatus(runId);
  }

  async recordCommandSent(input: {
    runId: string;
    commandId: string;
    commandType: string;
  }): Promise<void> {
    await this.runEvents.append(this.runEvents.commandSent(input));
  }

  async publish(message: RunChannelMessage<unknown>): Promise<void> {
    const { runId, seq } = message;
    if (
      message.type === "run.status" &&
      this.shouldIgnoreRunStatus(
        runId,
        message.payload as RunStatusPayload
      )
    ) {
      return;
    }

    const lastSeq = this.lastSeqMap.get(runId) ?? 0;
    this.logger.debug(
      `publish message ${safeLogJson({
        runId,
        seq,
        lastSeq,
        type: message.type,
        payload: summarizeMessagePayload(message.payload),
      })}`
    );

    // Dedup: drop if seq <= lastSeq
    if (seq <= lastSeq) {
      this.logger.warn(
        `drop duplicate message ${safeLogJson({
          runId,
          seq,
          lastSeq,
          origin: "worker",
          type: message.type,
        })}`
      );
      return;
    }
    if (seq > lastSeq + 1) {
      const expected = lastSeq + 1;
      this.logger.warn(
        `seq gap detected ${safeLogJson({
          runId,
          expected,
          got: seq,
          origin: "worker",
          type: message.type,
        })}`
      );
      // gap 只 warn 不可在管理端追溯；落一条摘要事件，使其在 run detail 中可见。
      this.recordSeqGap({
        runId,
        expected,
        got: seq,
        messageType: message.type,
      });
    }
    this.lastSeqMap.set(runId, seq);

    switch (message.type) {
      case "run.status":
        await this.handleRunStatus(runId, message.payload as RunStatusPayload);
        break;
      case "agui.event":
        await this.aguiEvents.handle(runId, message.payload);
        break;
      case "sdk.raw":
        this.recordSdkRaw(runId, message.payload);
        break;
      case "command.trace":
        this.recordCommandTrace(
          runId,
          message.payload as CommandTracePayload
        );
        break;
      case "command.result":
        this.recordCommandResult(
          runId,
          message.payload as CommandResultPayload
        );
        break;
    }
  }

  /** 强制将 run 标记为终态 error，跳过 seq 去重（worker 异常退出 / run 超时场景）。 */
  async forceErrorStatus(runId: string, error: string): Promise<void> {
    await this.handleRunStatus(runId, { status: "error", error });
  }

  async markRunTimedOut(
    runId: string,
    runtimeHandle: WorkerExecutionHandle
  ): Promise<void> {
    try {
      await this.forceErrorStatus(runId, "run timeout");
    } finally {
      this.executionService.terminateExecution(
        runtimeHandle,
        "run timeout"
      );
    }
  }

  /** 强制将 run 标记为终态 cancelled，跳过 seq 去重（启动中取消且 worker 尚未上报场景）。 */
  async forceCancelledStatus(runId: string): Promise<void> {
    await this.handleRunStatus(runId, { status: "cancelled" });
  }

  /** run 是否已在终态处理中或已完成终态（供 provider 的 exit handler 判断是否跳过 error 发布）。 */
  isTerminalOrFinalizing(runId: string): boolean {
    return this.finalizingRuns.has(runId) || this.completedRuns.has(runId);
  }

  private async handleRunStatus(
    runId: string,
    payload: RunStatusPayload
  ) {
    const decision = decideRunStatusUpdate({
      nextStatus: payload.status,
      terminalOrFinalizing: this.isTerminalOrFinalizing(runId),
    });
    if (decision.action === "ignore") {
      this.logIgnoredRunStatus(runId, payload);
      return;
    }
    const effect = decision.effect;
    const isTerminal = effect.isTerminal;
    const statusLogLevel = isTerminal ? "log" : "debug";
    this.logger[statusLogLevel](
      `run status ${safeLogJson({
        runId,
        status: payload.status,
        pendingAction: payload.pendingAction,
        error: payload.error,
      })}`
    );
    if (isTerminal) {
      this.finalizingRuns.add(runId);
    }
    this.recordRunStatus(runId, payload);

    try {
      const handle = this.liveRuns.get(runId);

      // 终态完成后记录 completed，阻止延迟的 exit handler 覆盖。
      // 必须在 saveRun/stream write 等可能抛异常的操作之前设置，
      // 否则异常会跳过 completedRuns.set，导致终态 guard 失效。
      if (isTerminal && !this.completedRuns.has(runId)) {
        const timer = setTimeout(
          () => this.completedRuns.delete(runId),
          COMPLETED_RUN_TTL_MS
        );
        timer.unref();
        this.completedRuns.set(runId, timer);
      }

      await this.runStatusService.apply({
        runId,
        payload,
        effect,
        handle,
      });
    } finally {
      if (isTerminal) {
        this.finalizingRuns.delete(runId);
        this.lastSeqMap.delete(runId);
        this.aguiEvents.clearRun(runId);
        this.runEvents.forgetRun(runId);
      }
    }
  }

  private recordSeqGap(input: {
    runId: string;
    expected: number;
    got: number;
    messageType: string;
  }): void {
    this.recordRunEvent(
      this.runEvents.fromWorkerSeqGap(input),
      `record worker seq gap for run ${input.runId}`
    );
  }

  private recordRunStatus(runId: string, payload: RunStatusPayload): void {
    this.recordRunEvent(
      this.runEvents.fromRunStatusPayload(runId, payload),
      `record run status event for run ${runId}`
    );
  }

  private recordSdkRaw(runId: string, event: unknown): void {
    this.recordRunEvent(
      this.runEvents.fromSdkRawEvent(runId, event),
      `record raw SDK error event for run ${runId}`
    );
  }

  private recordCommandTrace(
    runId: string,
    payload: CommandTracePayload
  ): void {
    this.recordRunEvent(
      this.runEvents.fromCommandTrace(runId, payload),
      `record command trace for run ${runId}`
    );
  }

  private recordCommandResult(
    runId: string,
    payload: CommandResultPayload
  ): void {
    this.recordRunEvent(
      this.runEvents.fromCommandResult(runId, payload),
      `record command result for run ${runId}`
    );
  }

  private recordRunEvent(
    event: RecordRunEventInput | undefined,
    context: string
  ): void {
    if (!event) return;
    this.runEvents.append(event).catch(swallow(this.logger, context));
  }

  private shouldIgnoreRunStatus(
    runId: string,
    payload: RunStatusPayload
  ): boolean {
    const decision = decideRunStatusUpdate({
      nextStatus: payload.status,
      terminalOrFinalizing: this.isTerminalOrFinalizing(runId),
    });
    if (decision.action === "apply") return false;
    this.logIgnoredRunStatus(runId, payload);
    return true;
  }

  private logIgnoredRunStatus(runId: string, payload: RunStatusPayload): void {
    this.logger.warn(
      `skip run status after terminal ${safeLogJson({
        runId,
        status: payload.status,
        pendingAction: payload.pendingAction,
        error: payload.error,
      })}`
    );
  }
}
