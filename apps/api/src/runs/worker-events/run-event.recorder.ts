import { Injectable, Logger } from "@nestjs/common";
import type {
  CommandResultPayload,
  CommandTracePayload,
  RecordRunEventInput,
  RunStatusPayload,
} from "@agework/shared/protocol";
import { swallow } from "../../common/swallow";
import { RunEventService } from "../../run-events/run-event.service";

@Injectable()
export class WorkerRunEventRecorder {
  private readonly logger = new Logger(WorkerRunEventRecorder.name);

  constructor(private readonly runEvents: RunEventService) {}

  shouldLogAgUiEvent(eventType: string): boolean {
    return this.runEvents.shouldLogAgUiEvent(eventType);
  }

  recordSeqGap(input: {
    runId: string;
    expected: number;
    got: number;
    messageType: string;
  }): void {
    const { runId } = input;
    this.record(
      this.runEvents.fromWorkerSeqGap(input),
      `record worker seq gap for run ${runId}`
    );
  }

  recordRunStatus(runId: string, payload: RunStatusPayload): void {
    this.record(
      this.runEvents.fromRunStatusPayload(runId, payload),
      `record run status event for run ${runId}`
    );
  }

  recordAgUi(
    runId: string,
    eventType: string,
    event: Record<string, unknown>
  ): void {
    const events = this.runEvents.fromAgUiEvent(runId, eventType, event);
    for (const event of events) {
      this.record(
        event,
        `record AG-UI event ${eventType} for run ${runId}`
      );
    }
  }

  recordSdkRaw(runId: string, event: unknown): void {
    this.record(
      this.runEvents.fromSdkRawEvent(runId, event),
      `record raw SDK error event for run ${runId}`
    );
  }

  recordCommandTrace(runId: string, payload: CommandTracePayload): void {
    this.record(
      this.runEvents.fromCommandTrace(runId, payload),
      `record command trace for run ${runId}`
    );
  }

  recordCommandResult(runId: string, payload: CommandResultPayload): void {
    this.record(
      this.runEvents.fromCommandResult(runId, payload),
      `record command result for run ${runId}`
    );
  }

  forgetRun(runId: string): void {
    this.runEvents.forgetRun(runId);
  }

  private record(event: RecordRunEventInput | undefined, context: string): void {
    if (!event) return;
    this.runEvents.append(event).catch(swallow(this.logger, context));
  }
}
