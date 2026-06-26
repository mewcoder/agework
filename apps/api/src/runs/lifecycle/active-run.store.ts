import { Injectable, Logger } from "@nestjs/common";
import type { Response } from "express";
import type {
  AgentEventTraceConfig,
  WorkerExecutionHandle,
} from "@agework/shared/protocol";
import type {
  IncompleteMessageReason,
  RunMessageAggregator,
} from "../messages/run-message.aggregator";
import { ConfigService } from "../../config/config.service";
import { errorLogFields, safeLogJson } from "../../common/logging";

export interface RunTimeoutErrorSink {
  markRunTimedOut(
    runId: string,
    runtimeHandle: WorkerExecutionHandle
  ): Promise<void>;
}

export type RunHandle = {
  runtimeHandle: WorkerExecutionHandle;
  res: Response | null;
  aggregator: RunMessageAggregator;
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
  /**
   * 当前 SSE 连接是否以「累积快照」模式推送。
   * 正常 run=false：转发原始 AG-UI 事件（前端 ChatHttpAgent 期望）。
   * resume 接续=true：每次事件 build 一个 ChatModelRunResult 快照推送
   *   （前端 ThreadHistoryAdapter.resume 直接 yield）。
   */
  streamingSnapshot?: boolean;
};

@Injectable()
export class RunActiveStore {
  private readonly logger = new Logger(RunActiveStore.name);
  private readonly handles = new Map<string, RunHandle>();
  private readonly timeoutTimers = new Map<string, NodeJS.Timeout>();
  private timeoutErrorSink?: RunTimeoutErrorSink;

  constructor(private readonly configService: ConfigService) {}

  setTimeoutErrorSink(sink: RunTimeoutErrorSink): void {
    this.timeoutErrorSink = sink;
  }

  register(runId: string, handle: RunHandle): void {
    this.clearRunTimeout(runId);
    this.handles.set(runId, handle);
    this.startTimeout(runId);
  }

  unregister(runId: string): void {
    this.clearRunTimeout(runId);
    this.handles.delete(runId);
  }

  get(runId: string): RunHandle | undefined {
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
