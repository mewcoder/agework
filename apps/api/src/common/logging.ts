export type LogLevel = "debug" | "log" | "warn" | "error";
export type NestLogLevel = "error" | "warn" | "log" | "debug" | "verbose";

const SECRET_KEY_RE =
  /(api[_-]?key|authorization|auth[_-]?token|token|password|secret|jwt|cookie)$/i;

export function errorLogFields(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      errorName: error.name,
      errorMessage: error.message,
      stack: error.stack,
    };
  }
  return { errorMessage: String(error) };
}

export function safeLogJson(value: unknown): string {
  try {
    return JSON.stringify(redactLogValue(value));
  } catch {
    return String(value);
  }
}

export function redactLogValue(value: unknown): unknown {
  return redactValue(value, "", new WeakSet<object>());
}

export function summarizeEnvelopePayload(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object") {
    return { value: String(payload) };
  }
  const record = payload as Record<string, unknown>;
  return {
    type: record.type,
    status: record.status,
    pendingAction: record.pendingAction,
    name: record.name,
  };
}

export function resolveNestLogLevels(): NestLogLevel[] {
  const raw = process.env.AGEWORK_LOG_LEVEL?.toLowerCase();
  if (raw === "debug") return ["error", "warn", "log", "debug"];
  if (raw === "warn") return ["error", "warn"];
  if (raw === "error") return ["error"];
  if (raw === "verbose") return ["error", "warn", "log", "debug", "verbose"];
  return process.env.NODE_ENV === "production"
    ? ["error", "warn", "log"]
    : ["error", "warn", "log", "debug"];
}

function redactValue(
  value: unknown,
  key: string,
  seen: WeakSet<object>
): unknown {
  if (SECRET_KEY_RE.test(key)) return "[redacted]";
  if (value instanceof Error) return errorLogFields(value);
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
