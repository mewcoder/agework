export type LogLevel = "debug" | "log" | "warn" | "error";
export type NestLogLevel =
  | "fatal"
  | "error"
  | "warn"
  | "log"
  | "debug"
  | "verbose";

const SECRET_KEY_RE =
  /(api[_-]?key|authorization|auth[_-]?token|token|password|secret|jwt|cookie)$/i;
const SECRET_VALUE_RE =
  /\b(api[_-]?key|authorization|auth[_-]?token|token|password|secret|jwt|cookie)\b\s*([:=])\s*(Bearer\s+[^\s,;]+|"[^"]*"|'[^']*'|[^\s,;]+)/gi;
const BEARER_TOKEN_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;

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

/**
 * AGEWORK_LOG_LEVEL 五档语义（低→高信息量）：
 * - error：仅严重错误
 * - warn ：错误 + 警告
 * - info ：一般操作信息（默认）
 * - debug：详细信息
 * - trace：全部日志，含逐事件 upstream 流水（最详细）
 * 未设置时默认 info（不含 debug/trace），dev/prod 一致。`verbose` 作为 `trace` 旧别名保留。
 */
export function resolveNestLogLevels(): NestLogLevel[] {
  switch (process.env.AGEWORK_LOG_LEVEL?.toLowerCase()) {
    case "error":
      return ["fatal", "error"];
    case "warn":
      return ["fatal", "error", "warn"];
    case "debug":
      return ["fatal", "error", "warn", "log", "debug"];
    case "trace":
    case "verbose":
      return ["fatal", "error", "warn", "log", "debug", "verbose"];
    case "info":
    default:
      return ["fatal", "error", "warn", "log"];
  }
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
  if (typeof value === "function")
    return `[function ${value.name || "anonymous"}]`;
  if (typeof value === "string") return redactSensitiveString(value);
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

function redactSensitiveString(value: string): string {
  return value
    .replace(SECRET_VALUE_RE, (_match, key: string, separator: string) => {
      return `${key}${separator}[redacted]`;
    })
    .replace(BEARER_TOKEN_RE, "Bearer [redacted]");
}
