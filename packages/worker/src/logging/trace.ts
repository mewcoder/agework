import type {
  AgentEventTraceConfig,
  AgentEventTracePayload,
  AgentTraceEvent,
  AgentTraceSink,
} from "@agework/shared/protocol";
import { appendFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";

const SECRET_KEY_RE =
  /(api[_-]?key|authorization|auth[_-]?token|token|password|secret|jwt|cookie)$/i;

export class TraceLogWriter {
  private readonly truncated = new Set<string>();

  constructor(private readonly config: AgentEventTraceConfig | undefined) {}

  get enabled(): boolean {
    return Boolean(
      this.config?.enabled &&
        (this.config.rawRuntimeFilePath || this.config.aguiRuntimeFilePath)
    );
  }

  static disabled(): TraceLogWriter {
    return new TraceLogWriter(undefined);
  }

  sink(): AgentTraceSink | undefined {
    if (!this.enabled) return undefined;
    return (event: AgentTraceEvent) => {
      this.writeSdkRaw(event);
    };
  }

  writeSdkRaw(event: AgentTraceEvent): void {
    if (!this.enabled || !this.config?.rawRuntimeFilePath) return;
    const payload: AgentEventTracePayload = {
      name: event.name,
      runId: event.runId ?? this.config.runId,
      threadId: event.threadId,
      conversationId: this.config.conversationId,
      workspaceId: this.config.workspaceId,
      agentType: this.config.agentType,
      ...(event.payload !== undefined ? { payload: redact(event.payload) } : {}),
    };

    this.writeRawFile(this.config.rawRuntimeFilePath, payload);
  }

  writeAgui(event: unknown): void {
    if (!this.enabled || !this.config?.aguiRuntimeFilePath) return;
    this.writeLogFile(
      this.config.aguiRuntimeFilePath,
      "agui.event",
      aguiLogEntry(this.config, event)
    );
  }

  private writeRawFile(
    filePath: string,
    trace: AgentEventTracePayload
  ): boolean {
    return this.writeLogFile(filePath, "sdk.raw", rawLogEntry(this.config!, trace));
  }

  private writeLogFile(
    filePath: string,
    source: "sdk.raw" | "agui.event",
    entry: Record<string, unknown>
  ): boolean {
    if (this.truncated.has(filePath)) return true;
    try {
      mkdirSync(dirname(filePath), { recursive: true });
      if (this.isOverLimit(filePath)) {
        this.writeTruncated(filePath, source);
        return true;
      }
      appendFileSync(filePath, `${JSON.stringify(entry)}\n`);
      return true;
    } catch {
      // Raw trace must never break agent execution.
      return false;
    }
  }

  private isOverLimit(filePath: string): boolean {
    const maxFileMb = this.config?.maxFileMb;
    if (!maxFileMb || !existsSync(filePath)) return false;
    return statSync(filePath).size >= maxFileMb * 1024 * 1024;
  }

  private writeTruncated(filePath: string, source: "sdk.raw" | "agui.event"): void {
    if (!this.config || this.truncated.has(filePath)) return;
    this.truncated.add(filePath);
    appendFileSync(
      filePath,
      `${JSON.stringify({
        ts: new Date().toISOString(),
        source,
        name: "trace.truncated",
        runId: this.config.runId,
        conversationId: this.config.conversationId,
        workspaceId: this.config.workspaceId,
        agentType: this.config.agentType,
        payload: { maxFileMb: this.config.maxFileMb },
      })}\n`
    );
  }
}

function redact(value: unknown): unknown {
  return redactValue(value, "", new WeakSet<object>());
}

function redactValue(
  value: unknown,
  key: string,
  seen: WeakSet<object>
): unknown {
  if (SECRET_KEY_RE.test(key)) return "[redacted]";
  if (value instanceof Error) return serializeError(value);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function") return `[function ${value.name || "anonymous"}]`;
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, "", seen));
  }

  const output: Record<string, unknown> = {};
  for (const [childKey, childValue] of Object.entries(
    value as Record<string, unknown>
  )) {
    output[childKey] = redactValue(childValue, childKey, seen);
  }
  return output;
}

function serializeError(error: Error): Record<string, unknown> {
  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
  };
}

function rawLogEntry(
  config: AgentEventTraceConfig,
  trace: AgentEventTracePayload
): Record<string, unknown> {
  return {
    ts: new Date().toISOString(),
    source: "sdk.raw",
    name: trace.name,
    runId: trace.runId ?? config.runId,
    conversationId: trace.conversationId ?? config.conversationId,
    workspaceId: trace.workspaceId ?? config.workspaceId,
    agentType: trace.agentType ?? config.agentType,
    payload: {
      ...(trace.runId ? { runId: trace.runId } : {}),
      ...(trace.threadId ? { threadId: trace.threadId } : {}),
      ...(trace.payload !== undefined ? { payload: trace.payload } : {}),
    },
  };
}

function aguiLogEntry(
  config: AgentEventTraceConfig,
  event: unknown
): Record<string, unknown> {
  return {
    ts: new Date().toISOString(),
    source: "agui.event",
    name: aguiEventName(event),
    runId: config.runId,
    conversationId: config.conversationId,
    workspaceId: config.workspaceId,
    agentType: config.agentType,
    payload: redact(event),
  };
}

function aguiEventName(event: unknown): string {
  if (event && typeof event === "object" && "type" in event) {
    const type = (event as { type?: unknown }).type;
    if (typeof type === "string") return type;
  }
  return "unknown";
}
