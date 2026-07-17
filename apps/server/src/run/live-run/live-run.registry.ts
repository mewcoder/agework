import { Injectable, Logger, OnApplicationShutdown } from "@nestjs/common";
import type { RunExecutionHandle } from "@agework/shared/protocol";
import type {
  IncompleteMessageReason,
  AssistantMessageAggregator,
} from "../upstream/assistant-message.aggregator";
import { ConfigService } from "../../config/config.service";
import { errorLogFields } from "../../common/logging";
import type { RunStream } from "../streaming/run.stream";

export interface RunTimeoutErrorPort {
  markRunTimedOut(
    runId: string,
    runtimeHandle: RunExecutionHandle
  ): Promise<void>;
}

export type LiveRunHandle = {
  runtimeHandle: RunExecutionHandle;
  stream: RunStream;
  aggregator: AssistantMessageAggregator;
  conversationId: string;
  runId: string;
  workspaceId: string;
  agentType: string;
  stopRequested: boolean;
  stopReason?: IncompleteMessageReason;
  saveRun: (
    complete: boolean,
    incompleteReason?: IncompleteMessageReason
  ) => Promise<void>;
  onAgentSessionId?: (sessionId: string) => Promise<void>;
};

@Injectable()
export class LiveRunRegistry implements OnApplicationShutdown {
  private readonly logger = new Logger(LiveRunRegistry.name);
  private readonly handles = new Map<string, LiveRunHandle>();
  private readonly timeoutTimers = new Map<string, NodeJS.Timeout>();
  private timeoutErrorPort?: RunTimeoutErrorPort;

  constructor(private readonly configService: ConfigService) {}

  setTimeoutErrorPort(port: RunTimeoutErrorPort): void {
    this.timeoutErrorPort = port;
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

  /**
   * 进程退出时清掉所有 run 超时 timer。timer 虽已 unref（不阻塞退出），
   * 但清掉可避免 shutdown 过程中误触发 timeout port 去改 run 状态。
   * run 状态由重启后 RunRecoveryService 收敛。
   */
  onApplicationShutdown(): void {
    for (const timer of this.timeoutTimers.values()) {
      clearTimeout(timer);
    }
    this.timeoutTimers.clear();
  }

  private startTimeout(runId: string): void {
    const timeoutSeconds = this.configService.getRunTimeoutSeconds();
    const timeoutMs = timeoutSeconds * 1000;
    const timer = setTimeout(() => {
      this.timeoutTimers.delete(runId);
      const handle = this.handles.get(runId);
      if (!handle) return;
      const timeoutErrorPort = this.timeoutErrorPort;
      if (!timeoutErrorPort) {
        this.logger.error("run timeout error port missing", { runId });
        return;
      }
      timeoutErrorPort
        .markRunTimedOut(runId, handle.runtimeHandle)
        .catch((err) => {
          this.logger.error("force run timeout status failed", {
            runId,
            ...errorLogFields(err),
          });
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
