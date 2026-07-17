import type { RunStatus } from "@agework/shared";

export type RunStatusPersistenceAction =
  | "markRunning"
  | "markRequiresAction"
  | "markFinished"
  | "markError"
  | "markCancelled";

export type RunTerminalConversationStatus = "idle" | "error";
export type RunTerminalIncompleteReason = "cancelled" | "error";

export type RunStatusEffect = {
  status: RunStatus;
  persistenceAction?: RunStatusPersistenceAction;
  terminal: boolean;
  savePartialMessage: boolean;
  terminalConversationStatus?: RunTerminalConversationStatus;
  terminalMessageComplete?: boolean;
  terminalIncompleteReason?: RunTerminalIncompleteReason;
};

export const ACTIVE_RUN_STATUSES: RunStatus[] = [
  "queued",
  "preparing",
  "running",
  "cancelling",
  "requires_action",
];

export function isActiveRunStatus(status: string): boolean {
  return (ACTIVE_RUN_STATUSES as string[]).includes(status);
}

export const RUNNING_MUTABLE_STATUSES: RunStatus[] = [
  "queued",
  "preparing",
  "running",
  "requires_action",
];

const RUN_STATUS_EFFECTS: Record<RunStatus, RunStatusEffect> = {
  queued: {
    status: "queued",
    terminal: false,
    savePartialMessage: false,
  },
  preparing: {
    status: "preparing",
    terminal: false,
    savePartialMessage: false,
  },
  running: {
    status: "running",
    persistenceAction: "markRunning",
    terminal: false,
    savePartialMessage: false,
  },
  requires_action: {
    status: "requires_action",
    persistenceAction: "markRequiresAction",
    terminal: false,
    savePartialMessage: true,
  },
  cancelling: {
    status: "cancelling",
    terminal: false,
    savePartialMessage: false,
  },
  finished: {
    status: "finished",
    persistenceAction: "markFinished",
    terminal: true,
    savePartialMessage: false,
    terminalConversationStatus: "idle",
    terminalMessageComplete: true,
  },
  error: {
    status: "error",
    persistenceAction: "markError",
    terminal: true,
    savePartialMessage: false,
    terminalConversationStatus: "error",
    terminalMessageComplete: false,
    terminalIncompleteReason: "error",
  },
  cancelled: {
    status: "cancelled",
    persistenceAction: "markCancelled",
    terminal: true,
    savePartialMessage: false,
    terminalConversationStatus: "idle",
    terminalMessageComplete: false,
    terminalIncompleteReason: "cancelled",
  },
};

export type RunStatusDecision =
  | { action: "apply"; effect: RunStatusEffect }
  | { action: "ignore"; reason: "terminal_already_recorded" };

export function runStatusEffect(status: RunStatus): RunStatusEffect {
  return RUN_STATUS_EFFECTS[status];
}

export function decideRunStatusUpdate(input: {
  nextStatus: RunStatus;
  terminalOrFinalizing: boolean;
}): RunStatusDecision {
  if (input.terminalOrFinalizing) {
    return { action: "ignore", reason: "terminal_already_recorded" };
  }
  return {
    action: "apply",
    effect: runStatusEffect(input.nextStatus),
  };
}
