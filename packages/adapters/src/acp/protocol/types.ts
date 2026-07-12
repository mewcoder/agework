/** Stable error codes for the ACP adapter (see the development doc §19). */
export type AcpErrorCode =
  | "ACP_BINARY_NOT_FOUND"
  | "ACP_PROCESS_START_FAILED"
  | "ACP_START_TIMEOUT"
  | "ACP_PROTOCOL_ERROR"
  | "ACP_VERSION_UNSUPPORTED"
  | "ACP_INITIALIZE_FAILED"
  | "ACP_SESSION_CREATE_FAILED"
  | "ACP_SESSION_NOT_FOUND"
  | "ACP_SESSION_RESUME_UNSUPPORTED"
  | "ACP_PROMPT_FAILED"
  | "ACP_PERMISSION_INVALID"
  | "ACP_PERMISSION_TIMEOUT"
  | "ACP_CONTENT_UNSUPPORTED"
  | "ACP_AGENT_EXITED";

/**
 * Error raised by the ACP adapter. Carries a stable {@link AcpErrorCode} for
 * callers to branch on; the message stays terse (detailed diagnostics belong in
 * the raw trace, never surfaced verbatim to the frontend).
 */
export class AcpError extends Error {
  constructor(
    readonly code: AcpErrorCode,
    message: string,
    readonly cause?: unknown
  ) {
    super(message);
    this.name = "AcpError";
  }
}
