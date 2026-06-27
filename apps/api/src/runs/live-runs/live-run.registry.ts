import { Injectable, Logger } from "@nestjs/common";
import type {
  AgentEventTraceConfig,
  WorkerExecutionHandle,
} from "@agework/shared/protocol";
import type {
  IncompleteMessageReason,
  AssistantMessageAggregator,
} from "../assistant-message.aggregator";
import { ConfigService } from "../../config/config.service";
import { errorLogFields, safeLogJson } from "../../common/logging";
import type { RunStream } from "../streaming/run-stream";

export interface RunTimeoutErrorSink {
  markRunTimedOut(
    runId: string,
    runtimeHandle: WorkerExecutionHandle
  ): Promise<void>;
}

export type LiveRunHandle = {
  runtimeHandle: WorkerExecutionHandle;
  stream: RunStream;
  aggregator: AssistantMessageAggregator;
  conversationId: string;
  runId: string;
  workspaceId: string;
  agentType: string;
  agentEventTrace?: AgentEventTraceConfig;
  stopRequested: boolean;
  stopReason?: IncompleteMessageReason;
  saveRun: (
    complete: boolean,
    incompleteReason?: IncompleteMessageReason
  ) => void;
  onAgentSessionId?: (sessionId: string) => void;
};

@Injectable()
export class LiveRunRegistry {
  private readonly logger = new Logger(LiveRunRegistry.name);
  private readonly handles = new Map<string, LiveRunHandle>();
  private readonly timeoutTimers = new Map<string, NodeJS.Timeout>();
  private timeoutErrorSink?: RunTimeoutErrorSink;

  constructor(private readonly configService: ConfigService) {}

  setTimeoutErrorSink(sink: RunTimeoutErrorSink): void {
    this.timeoutErrorSink = sink;
  }

  register(runId: string, handle: LiveRunHandle): void {
    this.clearRunTimeout(runId);
    this.handles.set(runId, handle);
    this.startTimeout(runId);
  }

  unregister(runId: string): void {
    this.clearRunTimeout(runId);
    this.handles.delete(runId);
  }

  get(runId: string): LiveRunHandle | undefined {
    return this.handles.get(runId);
  }

  private startTimeout(runId: string): void {
    const timeoutSeconds = this.configService.getRunTimeoutSeconds();
    const timeoutMs = timeoutSeconds * 1000;
    const timer = setTimeout(() => {
      this.timeoutTimers.delete(runId);
      const handle = this.handles.get(runId);
      if (!handle) return;
      const timeoutErrorSink = this.timeoutErrorSink;
      if (!timeoutErrorSink) {
        this.logger.error(
          `run timeout error sink missing ${safeLogJson({ runId })}`
        );
        return;
      }
      timeoutErrorSink
        .markRunTimedOut(runId, handle.runtimeHandle)
        .catch((err) => {
          this.logger.error(
            `force run timeout status failed ${safeLogJson({
              runId,
              ...errorLogFields(err),
            })}`
          );
        });
    }, timeoutMs);
    timer.unref();
    this.timeoutTimers.set(runId, timer);
  }

  private clearRunTimeout(runId: string): void {
    const timer = this.timeoutTimers.get(runId);
    if (!timer) return;
    clearTimeout(timer);
    this.timeoutTimers.delete(runId);
  }
}
