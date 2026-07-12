import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import type {
  RunChannelMessage,
  RunStatusPayload,
  CommandResultPayload,
  CommandTracePayload,
  WorkerExecutionHandle,
  RecordRunEventInput,
} from "@agework/shared/protocol";
import type { RunEventPort } from "../driver/run-event.port";
import type { WorkerUpstreamPort } from "../../worker-manager/worker-manager.types";
import { WorkerManagerService } from "../../worker-manager/worker-manager.service";
import {
  LiveRunRegistry,
  type RunTimeoutErrorPort,
} from "../live-run/live-run.registry";
import { RunDriver } from "../driver/run-driver";
import { swallow } from "../../common/swallow";
import { isTerminalRunStatus } from "@agework/shared";
import { type RunStatusDecision } from "../status/run-status.policy";
import { RunStatusService } from "../status/run-status.service";
import { WorkerSeqStore } from "./worker-seq.store";
import { RunEventService } from "../../run-event/run-event.service";
import { WorkerAgUiEventHandler } from "./worker-agui-event.handler";

/**
 * worker 上行事件的统一入口:seq 闸门(去重 / gap 诊断)+ 按消息类型分发。
 * run.status 的整条处理序列(决策、落库、终态收敛与清理)由 RunStatusService
 * 独立持有,这里只做入口守卫与转发。
 */

/** trace 档逐事件日志用的精简标签；完整 payload 见 <conversationId>.agui.jsonl。 */
function payloadTag(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const p = payload as { type?: unknown; name?: unknown; status?: unknown };
  const parts = [p.type, p.name ?? p.status].filter(
    (v): v is string => typeof v === "string"
  );
  return parts.length ? parts.join(":") : undefined;
}

@Injectable()
export class WorkerEventService
  implements OnModuleInit, RunEventPort, WorkerUpstreamPort, RunTimeoutErrorPort
{
  private readonly logger = new Logger(WorkerEventService.name);

  constructor(
    private readonly liveRuns: LiveRunRegistry,
    private readonly runEvents: RunEventService,
    private readonly runStatusService: RunStatusService,
    private readonly driver: RunDriver,
    private readonly aguiEvents: WorkerAgUiEventHandler,
    private readonly seqGate: WorkerSeqStore,
    private readonly workerManager: WorkerManagerService
  ) {}

  /** Port 自接线:本类是三个反向端口的实现者,启动期把自己注册给各下层调用方。 */
  onModuleInit(): void {
    this.driver.setRunEventPort(this);
    this.workerManager.setUpstreamPort(this);
    this.liveRuns.setTimeoutErrorPort(this);
  }

  async sendEvent(
    runId: string,
    message: RunChannelMessage<unknown>
  ): Promise<void> {
    this.logger.verbose("worker event received", {
      runId,
      seq: message.seq,
      type: message.type,
      event: payloadTag(message.payload),
    });

    // 先取出 handle：终态处理会 unregister，之后就拿不到 runtimeType 了。
    const handle = this.liveRuns.get(runId);

    await this.publish(message).catch((err) => {
      this.logger.warn(
        `WorkerEventService.publish failed for runId=${runId}: ${String(err)}`
      );
    });

    if (message.type === "run.status") {
      const { status } = message.payload as RunStatusPayload;
      if (isTerminalRunStatus(status) && handle) {
        this.driver.cleanup(handle.runtimeHandle.runId);
      }
    }
  }

  async notifyWorkerError(runId: string, error: string): Promise<void> {
    if (this.isTerminalOrFinalizing(runId)) return;
    await this.forceErrorStatus(runId, error);
  }

  /** worker 心跳超时被 fence 掉时终结其名下 in-flight run,复用 notifyWorkerError 的终态判断。 */
  async notifyWorkerLost(runId: string, reason: string): Promise<void> {
    this.recordRunEvent(
      this.runEvents.workerStatusChanged({ runId, status: "lost", reason }),
      `record worker lost for run ${runId}`
    );
    await this.notifyWorkerError(runId, reason);
  }

  async notifyCancelledBeforeReady(runId: string): Promise<void> {
    if (this.isTerminalOrFinalizing(runId)) return;
    await this.forceCancelledStatus(runId);
  }

  async publish(message: RunChannelMessage<unknown>): Promise<void> {
    const { runId, seq } = message;
    // run.status 的 apply/ignore 决策只算这一次,通过决策的直接传给 handleRunStatus。
    // 拦截必须发生在 seq 记账之前:终态清理已 forget 该 run 的 seq 状态,
    // 迟到的状态消息不能再把它重建出来。
    let statusDecision: RunStatusDecision | undefined;
    if (message.type === "run.status") {
      statusDecision = this.runStatusService.decide(
        runId,
        message.payload as RunStatusPayload
      );
      if (statusDecision.action === "ignore") {
        this.logIgnoredRunStatus(runId, message.payload as RunStatusPayload);
        return;
      }
    }

    const decision = this.seqGate.accept(runId, seq);

    // Dedup: drop if seq <= lastSeq
    if (decision.action === "drop") {
      this.logger.warn("drop duplicate message", {
        runId,
        seq,
        lastSeq: decision.lastSeq,
        origin: "worker",
        type: message.type,
      });
      return;
    }
    if (decision.gap) {
      const { expected, got } = decision.gap;
      this.logger.warn("seq gap detected", {
        runId,
        expected,
        got,
        origin: "worker",
        type: message.type,
      });
      // gap 只 warn 不可在管理端追溯；落一条摘要事件，使其在 run detail 中可见。
      this.recordSeqGap({
        runId,
        expected,
        got,
        messageType: message.type,
      });
    }

    this.logger.verbose("publish message", {
      runId,
      seq,
      lastSeq: decision.lastSeq,
      type: message.type,
      event: payloadTag(message.payload),
    });

    switch (message.type) {
      case "run.status":
        await this.handleRunStatus(
          runId,
          message.payload as RunStatusPayload,
          statusDecision
        );
        break;
      case "agui.event":
        this.aguiEvents.handle(runId, message.payload);
        break;
      case "sdk.raw":
        this.recordSdkRaw(runId, message.payload);
        break;
      case "command.trace":
        this.recordCommandTrace(runId, message.payload as CommandTracePayload);
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
      this.driver.terminateExecution(runtimeHandle.runId, "run timeout");
    }
  }

  /** 强制将 run 标记为终态 cancelled，跳过 seq 去重（启动中取消且 worker 尚未上报场景）。 */
  async forceCancelledStatus(runId: string): Promise<void> {
    await this.handleRunStatus(runId, { status: "cancelled" });
  }

  /** run 是否已在终态处理中或已完成终态（供 provider 的 exit handler 判断是否跳过 error 发布）。 */
  isTerminalOrFinalizing(runId: string): boolean {
    return this.runStatusService.isTerminalOrFinalizing(runId);
  }

  private async handleRunStatus(
    runId: string,
    payload: RunStatusPayload,
    precomputedDecision?: RunStatusDecision
  ) {
    const decision =
      precomputedDecision ?? this.runStatusService.decide(runId, payload);
    if (decision.action === "ignore") {
      this.logIgnoredRunStatus(runId, payload);
      return;
    }
    await this.runStatusService.apply({
      runId,
      payload,
      effect: decision.effect,
    });
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

  private logIgnoredRunStatus(runId: string, payload: RunStatusPayload): void {
    this.logger.warn("skip run status after terminal", {
      runId,
      status: payload.status,
      pendingAction: payload.pendingAction,
      error: payload.error,
    });
  }
}
