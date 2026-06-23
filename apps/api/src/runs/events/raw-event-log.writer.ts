import { Injectable, Logger } from "@nestjs/common";
import { appendFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type {
  AgentEventTraceConfig,
  AgentEventTracePayload,
} from "@agework/shared/protocol";
import { errorLogFields, redactLogValue, safeLogJson } from "../../common/logging";

type AgentEventLogKind = "raw" | "agui";

type AgentEventLogEntry = {
  ts: string;
  source: "sdk.raw" | "agui.event";
  name: string;
  runId: string;
  conversationId: string;
  workspaceId: string;
  agentType: string;
  payload?: unknown;
};

@Injectable()
export class RawEventLogWriter {
  private readonly logger = new Logger(RawEventLogWriter.name);
  private readonly truncated = new Set<string>();

  writeRaw(config: AgentEventTraceConfig | undefined, payload: unknown): void {
    if (!config?.enabled || !config.rawFilePath) return;
    const trace = payload as AgentEventTracePayload | undefined;
    const name = typeof trace?.name === "string" ? trace.name : "unknown";
    this.write(config, "raw", {
      ts: new Date().toISOString(),
      source: "sdk.raw",
      name,
      runId: trace?.runId ?? config.runId,
      conversationId: trace?.conversationId ?? config.conversationId,
      workspaceId: trace?.workspaceId ?? config.workspaceId,
      agentType: trace?.agentType ?? config.agentType,
      payload: redactLogValue(tracePayload(trace)),
    });
  }

  writeAgui(config: AgentEventTraceConfig | undefined, event: unknown): void {
    if (!config?.enabled || !config.aguiFilePath) return;
    this.write(config, "agui", {
      ts: new Date().toISOString(),
      source: "agui.event",
      name: eventName(event),
      runId: config.runId,
      conversationId: config.conversationId,
      workspaceId: config.workspaceId,
      agentType: config.agentType,
      payload: redactLogValue(event),
    });
  }

  private write(
    config: AgentEventTraceConfig,
    kind: AgentEventLogKind,
    entry: AgentEventLogEntry
  ): void {
    const filePath = kind === "raw" ? config.rawFilePath : config.aguiFilePath;
    if (!filePath || this.truncated.has(filePath)) return;

    try {
      mkdirSync(dirname(filePath), { recursive: true });
      if (this.isOverLimit(filePath, config.maxFileMb)) {
        this.writeTruncated(filePath, config, kind);
        return;
      }
      appendFileSync(filePath, `${JSON.stringify(entry)}\n`);
    } catch (err) {
      this.logger.warn(
        `write agent event log failed ${safeLogJson({
          filePath,
          kind,
          runId: config.runId,
          conversationId: config.conversationId,
          ...errorLogFields(err),
        })}`
      );
    }
  }

  private isOverLimit(filePath: string, maxFileMb: number | undefined): boolean {
    if (!maxFileMb || !existsSync(filePath)) return false;
    return statSync(filePath).size >= maxFileMb * 1024 * 1024;
  }

  private writeTruncated(
    filePath: string,
    config: AgentEventTraceConfig,
    kind: AgentEventLogKind
  ): void {
    if (this.truncated.has(filePath)) return;
    this.truncated.add(filePath);
    const source = kind === "raw" ? "sdk.raw" : "agui.event";
    const entry: AgentEventLogEntry = {
      ts: new Date().toISOString(),
      source,
      name: "trace.truncated",
      runId: config.runId,
      conversationId: config.conversationId,
      workspaceId: config.workspaceId,
      agentType: config.agentType,
      payload: { maxFileMb: config.maxFileMb },
    };
    appendFileSync(filePath, `${JSON.stringify(entry)}\n`);
  }
}

function tracePayload(
  trace: AgentEventTracePayload | undefined
): Record<string, unknown> {
  return {
    ...(trace?.runId ? { runId: trace.runId } : {}),
    ...(trace?.threadId ? { threadId: trace.threadId } : {}),
    ...(trace?.payload !== undefined ? { payload: trace.payload } : {}),
  };
}

function eventName(event: unknown): string {
  if (event && typeof event === "object" && "type" in event) {
    const type = (event as { type?: unknown }).type;
    if (typeof type === "string") return type;
  }
  return "unknown";
}
