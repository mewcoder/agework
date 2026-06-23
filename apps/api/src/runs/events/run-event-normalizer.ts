import type {
  ControlTracePayload,
  RecordRunEventInput,
  RunStatusPayload,
} from "@agework/shared/protocol";
import { RunEventFacts } from "./run-event-facts";

export function workerSeqGapFact(input: {
  runId: string;
  expected: number;
  got: number;
  envelopeType: string;
}): RecordRunEventInput {
  return RunEventFacts.systemIssue({
    runId: input.runId,
    code: "worker_seq_gap",
    origin: "worker",
    severity: "warn",
    summary: `expected seq ${input.expected}, got ${input.got}`,
    data: {
      expected: input.expected,
      got: input.got,
      envelopeType: input.envelopeType,
    },
  });
}

export function runStatusFact(
  runId: string,
  payload: RunStatusPayload
): RecordRunEventInput {
  return RunEventFacts.runStatusChanged({
    runId,
    status: payload.status,
    phase: payload.phase,
    pendingAction: payload.pendingAction,
    error: payload.error,
    reason: pendingActionSummary(payload.pendingAction),
  });
}

export function shouldLogAgUiEvent(eventType: string): boolean {
  return (
    eventType.endsWith("_START") ||
    eventType.endsWith("_END") ||
    eventType === "RUN_STARTED" ||
    eventType === "RUN_ERROR"
  );
}

export function aguiEventFacts(
  runId: string,
  eventType: string,
  event: Record<string, unknown>
): RecordRunEventInput[] {
  const facts: RecordRunEventInput[] = [];
  switch (eventType) {
    case "RUN_ERROR":
      facts.push(
        RunEventFacts.systemIssue({
          runId,
          code: "agui_run_error",
          origin: "agent",
          severity: "error",
          summary: stringValue(event.message),
          message: stringValue(event.message),
        })
      );
      break;
    case "TOOL_CALL_START":
      pushFact(
        facts,
        RunEventFacts.toolStarted({
          runId,
          toolCallId: stringValue(event.toolCallId),
          toolName: stringValue(event.toolCallName),
          parentMessageId: stringValue(event.parentMessageId),
        })
      );
      break;
    case "TOOL_CALL_RESULT":
      {
        const preview = contentPreview(event.content);
        const error = toolResultError(event, preview);
        pushFact(
          facts,
          error
            ? RunEventFacts.toolFailed({
                runId,
                toolCallId: stringValue(event.toolCallId),
                messageId: stringValue(event.messageId),
                error,
                contentPreview: preview,
              })
            : RunEventFacts.toolCompleted({
                runId,
                toolCallId: stringValue(event.toolCallId),
                messageId: stringValue(event.messageId),
                contentPreview: preview,
              })
        );
      }
      break;
    case "TEXT_MESSAGE_START":
      pushFact(
        facts,
        RunEventFacts.messageStarted({
          runId,
          messageId: stringValue(event.messageId),
          role: stringValue(event.role),
        })
      );
      break;
    case "TEXT_MESSAGE_END":
      pushFact(
        facts,
        RunEventFacts.messageCompleted({
          runId,
          messageId: stringValue(event.messageId),
        })
      );
      break;
    default:
      break;
  }
  return facts;
}

export function sdkRawErrorFact(
  runId: string,
  event: unknown
): RecordRunEventInput | undefined {
  const trace = event as { name?: unknown; threadId?: unknown };
  const name = typeof trace?.name === "string" ? trace.name : "sdk.raw";
  const isError = name.toLowerCase().includes("error");
  if (!isError) return undefined;
  const threadId = stringValue(trace?.threadId);
  return RunEventFacts.systemIssue({
    runId,
    code: "sdk_error",
    origin: "agent",
    summary: name,
    data: {
      providerEventName: name,
      ...(threadId ? { threadId } : {}),
    },
  });
}

export function controlTraceFact(
  runId: string,
  payload: ControlTracePayload
): RecordRunEventInput {
  return payload.phase === "failed"
    ? RunEventFacts.controlFailed({
        runId,
        commandId: payload.commandId,
        controlType: payload.controlType,
        error: payload.error,
      })
    : RunEventFacts.controlHandled({
        runId,
        commandId: payload.commandId,
        controlType: payload.controlType,
        phase: payload.phase,
      });
}

function pendingActionSummary(pendingAction: unknown): string | undefined {
  if (typeof pendingAction === "string") return pendingAction;
  if (!pendingAction || typeof pendingAction !== "object") return undefined;
  const action = pendingAction as { type?: unknown; id?: unknown };
  return (
    [
      typeof action.type === "string" ? action.type : undefined,
      typeof action.id === "string" ? action.id : undefined,
    ]
      .filter(Boolean)
      .join(" / ") || undefined
  );
}

function pushFact<T>(facts: T[], fact: T | undefined): void {
  if (fact) {
    facts.push(fact);
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function contentPreview(value: unknown): string | undefined {
  if (typeof value === "string") return value.slice(0, 300);
  if (value === undefined || value === null) return undefined;
  try {
    return JSON.stringify(value).slice(0, 300);
  } catch {
    return String(value).slice(0, 300);
  }
}

function toolResultError(
  event: Record<string, unknown>,
  preview: string | undefined
): string | undefined {
  const directError =
    stringValue(event.error) ?? stringValue(event.errorMessage);
  if (directError) return directError;

  const contentError = errorFromContent(event.content);
  if (contentError) return contentError;

  const status = stringValue(event.status)?.toLowerCase();
  const failed =
    event.isError === true ||
    event.error === true ||
    status === "error" ||
    status === "failed";
  if (failed) return stringValue(event.message) ?? preview ?? "tool call failed";
  return undefined;
}

function errorFromContent(value: unknown): string | undefined {
  if (typeof value === "string") {
    try {
      return errorFromContent(JSON.parse(value));
    } catch {
      return undefined;
    }
  }
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const explicitError =
    stringValue(record.error) ?? stringValue(record.errorMessage);
  if (explicitError) return explicitError;

  const status = stringValue(record.status)?.toLowerCase();
  if (record.isError === true || status === "error" || status === "failed") {
    return stringValue(record.message);
  }
  return undefined;
}
