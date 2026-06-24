import { Injectable } from "@nestjs/common";
import type { Envelope, RunEventReceiver } from "@agework/shared/protocol";
import { RunEnvelopeProcessor } from "./run-envelope.processor";
import { RunEventRecorder } from "../events/run-event-recorder";
import { RunEventFacts } from "../events/run-event-facts";

/**
 * run 层提供给 runtime provider 的事件 receiver 实现：把 provider 产出的 worker 事件
 * 接回 RunEnvelopeProcessor / RunEventRecorder。runtime 侧只认 RunEventReceiver 接口。
 */
@Injectable()
export class RunEventReceiverImpl implements RunEventReceiver {
  constructor(
    private readonly processor: RunEnvelopeProcessor,
    private readonly recorder: RunEventRecorder
  ) {}

  publish(envelope: Envelope<unknown>): Promise<void> {
    return this.processor.publish(envelope);
  }

  isTerminalOrFinalizing(runId: string): boolean {
    return this.processor.isTerminalOrFinalizing(runId);
  }

  forceErrorStatus(runId: string, error: string): Promise<void> {
    return this.processor.forceErrorStatus(runId, error);
  }

  forceCancelledStatus(runId: string): Promise<void> {
    return this.processor.forceCancelledStatus(runId);
  }

  async recordControlSent(input: {
    runId: string;
    commandId: string;
    controlType: string;
  }): Promise<void> {
    await this.recorder.append(RunEventFacts.controlSent(input));
  }
}
