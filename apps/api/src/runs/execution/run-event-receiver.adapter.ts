import { Injectable } from "@nestjs/common";
import type { Envelope } from "@agework/shared/protocol";
import type { RunEventReceiver } from "../../runtime/providers/run-event-receiver.port";
import { RunEnvelopeProcessor } from "./run-envelope.processor";
import { RunEventRecorder } from "../events/run-event-recorder";
import { RunEventFacts } from "../events/run-event-facts";

/**
 * run 层提供给 runtime provider 的事件 receiver 实现：把 provider 产出的 worker 事件
 * 接回 RunEnvelopeProcessor / RunEventRecorder。runtime 侧只认 RunEventReceiver 接口。
 *
 * worker 异常 / cancel-before-ready 的状态转换由本 adapter 内部决定（查 run 当前状态
 * 后转终态），runtime 只通过 notify* 方法告知事实，不操纵 run 状态机。
 */
@Injectable()
export class RunEventReceiverAdapter implements RunEventReceiver {
  constructor(
    private readonly processor: RunEnvelopeProcessor,
    private readonly recorder: RunEventRecorder
  ) {}

  publish(envelope: Envelope<unknown>): Promise<void> {
    return this.processor.publish(envelope);
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
    await this.recorder.append(RunEventFacts.commandSent(input));
  }
}
