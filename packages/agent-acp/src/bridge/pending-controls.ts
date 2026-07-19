/** An interrupt surfaced to AG-UI when the agent requests permission. */
export type AcpInterrupt = {
  id: string;
  reason: string;
  message?: string;
  toolCallId?: string;
  metadata?: Record<string, unknown>;
};

/** One permission option the agent offered (echoed back to the frontend). */
export type AcpPermissionOption = {
  optionId: string;
  name: string;
  kind?: string;
};

/** A pending `session/request_permission` awaiting the user's decision. */
export type PendingAcpPermission = {
  threadId: string;
  sessionId: string;
  interruptId: string;
  toolCallId?: string;
  options: AcpPermissionOption[];
  /** Resolve with the chosen optionId (must be one of `options`). */
  resolve: (optionId: string) => void;
  reject: (error: Error) => void;
  /** Called with the resume runId before {@link resolve}, to emit the resume RUN_STARTED. */
  onResume?: (resumeRunId: string) => void;
};
