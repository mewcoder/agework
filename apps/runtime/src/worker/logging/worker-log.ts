import { appendFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";

const DEFAULT_LOG_FILE = "/tmp/agework-worker.log";
const DEFAULT_LOG_MAX_FILE_MB = 50;
const SECRET_KEY_RE =
  /(api[_-]?key|authorization|auth[_-]?token|token|password|secret|jwt|cookie)$/i;

export type WorkerLogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVEL_PRIORITY: Record<WorkerLogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

let workerLogFilePath: string | undefined;
let workerLogContext: Record<string, unknown> = initialWorkerLogContext();
const runLogFiles = new Map<string, string>();
const runConversationIds = new Map<string, string>();
const conversationLogFiles = new Map<string, string>();
const truncatedLogFiles = new Set<string>();

export function setWorkerLogFilePath(filePath: string | undefined): void {
  workerLogFilePath = filePath || undefined;
}

export function setWorkerLogContext(context: Record<string, unknown>): void {
  workerLogContext = compactObject({ ...workerLogContext, ...context });
}

export function registerWorkerRunLog(input: {
  runId: string;
  conversationId: string;
  filePath?: string;
}): void {
  if (!input.filePath) return;
  runLogFiles.set(input.runId, input.filePath);
  runConversationIds.set(input.runId, input.conversationId);
  conversationLogFiles.set(input.conversationId, input.filePath);
}

export function unregisterWorkerRunLog(runId: string): void {
  const conversationId = runConversationIds.get(runId);
  runLogFiles.delete(runId);
  runConversationIds.delete(runId);
  if (
    conversationId &&
    ![...runConversationIds.values()].includes(conversationId)
  ) {
    conversationLogFiles.delete(conversationId);
  }
}

export function resetWorkerLogForTests(): void {
  workerLogFilePath = undefined;
  workerLogContext = initialWorkerLogContext();
  runLogFiles.clear();
  runConversationIds.clear();
  conversationLogFiles.clear();
  truncatedLogFiles.clear();
}

export function errorDetails(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  return { message: String(error) };
}

export function workerLog(
  message: string,
  details?: Record<string, unknown>,
  level: WorkerLogLevel = "info"
): void {
  if (!shouldWrite(level)) return;
  const logDetails = compactObject({ ...workerLogContext, ...(details ?? {}) });
  const line = `${new Date().toISOString()} ${level} ${message}${Object.keys(logDetails).length ? ` ${safeJson(logDetails)}` : ""}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);

  const logFiles = resolveLogFiles(details);
  if (logFiles.length === 0) return;

  const jsonLine = safeJsonLine(buildLogRecord(message, level, logDetails));
  const maxFileMb = getMaxFileMb();
  for (const logFile of logFiles) {
    try {
      mkdirSync(dirname(logFile), { recursive: true });
      if (isOverLimit(logFile, maxFileMb)) {
        writeTruncatedMarker(logFile);
        continue;
      }
      appendFileSync(logFile, `${jsonLine}\n`);
    } catch {
      // Diagnostics must never break worker execution.
    }
  }
}

// 文件落盘统一为单行 JSON（JSONL），便于按 runId/seq/source/eventType 检索；
// stdout/stderr 仍保留上面的简洁文本行，供本地直接查看。
function buildLogRecord(
  message: string,
  level: WorkerLogLevel,
  logDetails: Record<string, unknown>
): Record<string, unknown> {
  const redacted = redact(logDetails) as Record<string, unknown>;
  return { time: new Date().toISOString(), level, message, ...redacted };
}

function safeJsonLine(record: Record<string, unknown>): string {
  try {
    return JSON.stringify(record);
  } catch {
    return JSON.stringify({
      ...record,
      error: "failed to serialize log record",
    });
  }
}

function getMaxFileMb(): number {
  const raw = Number(process.env.AGEWORK_WORKER_LOG_MAX_FILE_MB);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_LOG_MAX_FILE_MB;
}

function isOverLimit(filePath: string, maxFileMb: number): boolean {
  if (!existsSync(filePath)) return false;
  return statSync(filePath).size >= maxFileMb * 1024 * 1024;
}

function writeTruncatedMarker(filePath: string): void {
  if (truncatedLogFiles.has(filePath)) return;
  truncatedLogFiles.add(filePath);
  const line = safeJsonLine({
    time: new Date().toISOString(),
    level: "warn",
    message: "worker log truncated: reached size limit",
    source: "worker",
    eventType: "log.truncated",
  });
  appendFileSync(filePath, `${line}\n`);
}

function resolveLogFiles(
  details: Record<string, unknown> | undefined
): string[] {
  const files = new Set<string>();
  const defaultFile =
    workerLogFilePath ??
    process.env.AGEWORK_WORKER_LOG_FILE ??
    DEFAULT_LOG_FILE;
  if (defaultFile) files.add(defaultFile);

  const runId = typeof details?.runId === "string" ? details.runId : undefined;
  const conversationId =
    typeof details?.conversationId === "string"
      ? details.conversationId
      : undefined;
  const scopedFile =
    (runId ? runLogFiles.get(runId) : undefined) ??
    (conversationId ? conversationLogFiles.get(conversationId) : undefined);
  if (scopedFile) files.add(scopedFile);

  return [...files];
}

function shouldWrite(level: WorkerLogLevel): boolean {
  return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[getMinLevel()];
}

function getMinLevel(): WorkerLogLevel {
  const raw = process.env.AGEWORK_WORKER_LOG_LEVEL?.toLowerCase();
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") {
    return raw;
  }
  return process.env.NODE_ENV === "production" ? "info" : "debug";
}

function safeJson(value: Record<string, unknown>): string {
  try {
    return JSON.stringify(redact(value));
  } catch {
    return String(value);
  }
}

function initialWorkerLogContext(): Record<string, unknown> {
  return compactObject({
    workerRole: process.env.AGEWORK_WORKER_ROLE,
    runtimeType: process.env.AGEWORK_WORKER_RUNTIME_TYPE,
    scope: process.env.AGEWORK_WORKER_SCOPE,
    workerSubjectId: process.env.AGEWORK_WORKER_SUBJECT_ID,
    containerHostname: hostname(),
    workerPid: process.pid,
    nodeVersion: process.version,
  });
}

function compactObject(
  value: Record<string, unknown>
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, childValue]) => childValue !== undefined)
  );
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
  if (value instanceof Error) return errorDetails(value);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function")
    return `[function ${value.name || "anonymous"}]`;
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
