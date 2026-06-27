import { Injectable, Logger } from "@nestjs/common";
import type { RunStatus } from "@agework/shared";
import type { RunChannelMessage, RunStatusPayload } from "@agework/shared/protocol";
import type { RunEventReceiver } from "../../runtime/providers/run-event-receiver.port";
import type { WorkerUpstreamReceiver } from "../../worker-host/worker-upstream.registry";
import { WorkerEventProcessor } from "./worker-event.processor";
import { RunEventService } from "../events/run-event.service";
import { ActiveRunRegistry } from "../lifecycle/active-run.registry";
import { RunDriver } from "./run-driver";
import { safeLogJson, summarizeMessagePayload } from "../../common/logging";

const TERMINAL_RUN_STATUSES: RunStatus[] = ["finished", "error", "cancelled"];

/**
 * worker 事件进入 run 的统一入口。
 *
 * - local：runtime provider 从 child process IPC 收到 message 后调用 sendEvent()
 * - sandbox/HTTP：worker-host controller 收到 POST /events 后调用 sendEvent()
 *
 * worker 异常 / cancel-before-ready 的状态转换由本 adapter 内部决定（查 run 当前状态
 * 后转终态），runtime 只通过 notify* 方法告知事实，不操纵 run 状态机。
 */
@Injectable()
export class WorkerEventReceiverAdapter
  implements RunEventReceiver, WorkerUpstreamReceiver
{
  private readonly logger = new Logger(WorkerEventReceiverAdapter.name);

  constructor(
    private readonly processor: WorkerEventProcessor,
    private readonly runEvents: RunEventService,
    private readonly activeRuns: ActiveRunRegistry,
    private readonly runDriver: RunDriver
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

    // 发布前先取出 handle：WorkerEventProcessor 在终态时会 unregister，之后就拿不到 runtimeType 了。
    const handle = this.activeRuns.get(runId);

    await this.processEvent(message).catch((err) => {
      this.logger.warn(
        `WorkerEventProcessor.publish failed for runId=${runId}: ${String(err)}`
      );
    });

    if (message.type === "run.status") {
      const { status } = message.payload as RunStatusPayload;
      if (TERMINAL_RUN_STATUSES.includes(status) && handle) {
        this.runDriver.cleanup(handle.runtimeHandle);
      }
    }
  }

  async notifyWorkerError(runId: string, error: string): Promise<void> {
    if (this.processor.isTerminalOrFinalizing(runId)) return;
    await this.processor.forceErrorStatus(runId, error);
  }

  async notifyCancelledBeforeReady(runId: string): Promise<void> {
    if (this.processor.isTerminalOrFinalizing(runId)) return;
    await this.processor.forceCancelledStatus(runId);
  }

  async recordCommandSent(input: {
    runId: string;
    commandId: string;
    commandType: string;
  }): Promise<void> {
    await this.runEvents.append(this.runEvents.commandSent(input));
  }

  private processEvent(message: RunChannelMessage<unknown>): Promise<void> {
    // WorkerEventProcessor 内部做 seq 去重、状态转换、事件入库和消息聚合。
    return this.processor.publish(message);
  }
}
