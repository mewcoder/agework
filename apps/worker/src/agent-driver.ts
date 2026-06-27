import type { CommandPayload } from "@agework/shared/protocol";
import type { Subscription } from "rxjs";

export type AgentRunPayload = { threadId: string } & Record<string, unknown>;

/**
 * Worker-side run input for an agent driver.
 *
 * `payload` is still the existing AG-UI run input today. Keeping it behind this
 * worker-owned shape stops main/router from depending directly on adapter
 * details and gives future ACP/native drivers a stable insertion point.
 */
export type AgentRunInput = {
  /** AgeWork conversation id as seen at the AG-UI boundary. */
  aguiThreadId: string;
  payload: AgentRunPayload;
};

export type DriverEventStream = {
  subscribe(o: {
    next: (event: unknown) => void;
    complete: () => void;
    error: (error: Error) => void;
  }): Subscription;
};

export type AgentDriver = {
  /**
   * Start one logical agent turn. The driver emits UI/projectable events and
   * completes/errors when the turn reaches a terminal state.
   */
  run(input: AgentRunInput): DriverEventStream;
  /** Best-effort interruption of an active turn. */
  interrupt(aguiThreadId?: string): Promise<void>;
  /** User-visible cancellation; also clears pending human-control prompts. */
  cancel(aguiThreadId?: string): Promise<void>;
  /** Resolve a pending human-control command for this driver, if any. */
  resolveControl(command: CommandPayload): boolean | Promise<boolean>;
  /** Optional process/resource cleanup for long-lived drivers. */
  shutdown?(): Promise<void>;
};

export function toAgentRunInput(
  input: unknown,
  fallbackAguiThreadId: string
): AgentRunInput {
  const payload =
    input && typeof input === "object" && !Array.isArray(input)
      ? ({ ...(input as Record<string, unknown>) } as AgentRunPayload)
      : ({ input } as unknown as AgentRunPayload);
  const threadId =
    typeof payload.threadId === "string" && payload.threadId.length > 0
      ? payload.threadId
      : fallbackAguiThreadId;

  return {
    aguiThreadId: threadId,
    payload: {
      ...payload,
      threadId,
    },
  };
}
