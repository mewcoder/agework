import type { TerminalRunStatus } from "@agework/shared";

export type AgentTerminalOutcome = {
  status: TerminalRunStatus;
  error?: string;
};

/**
 * 把 adapter 的 AG-UI 终态和 Observable 终止信号收敛成唯一 run 终态。
 * adapter 会先 next(RUN_ERROR) 再 complete；complete 只是流结束，不能覆盖失败事实。
 */
export class AgentRunOutcome {
  private agentError?: string;

  observe(event: unknown): void {
    if (!isRunError(event)) return;
    this.agentError =
      typeof event.message === "string" && event.message.length > 0
        ? event.message
        : "agent run failed";
  }

  onComplete(stopRequested: boolean): AgentTerminalOutcome {
    if (stopRequested) return { status: "cancelled" };
    if (this.agentError) {
      return { status: "error", error: this.agentError };
    }
    return { status: "finished" };
  }
}

function isRunError(event: unknown): event is {
  type: "RUN_ERROR";
  message?: unknown;
} {
  return (
    typeof event === "object" &&
    event !== null &&
    "type" in event &&
    event.type === "RUN_ERROR"
  );
}
