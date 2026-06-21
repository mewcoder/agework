type LogLevel = "log" | "warn" | "error";

type LoggerTarget = {
  log: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

type LogFieldValue = string | number | boolean | null | undefined;

type CodexRunLoggerOptions = {
  logger?: Partial<LoggerTarget>;
  now?: () => number;
  threadId?: string;
  runId?: string;
};

export class CodexRunLogger {
  private readonly logger: Partial<LoggerTarget>;
  private readonly now: () => number;
  private readonly startedAt: number;
  private lastAt: number;
  private firstNotificationSeen = false;
  private firstVisibleEventSeen = false;

  constructor(private readonly options: CodexRunLoggerOptions) {
    this.logger = options.logger ?? console;
    this.now = options.now ?? Date.now;
    this.startedAt = this.now();
    this.lastAt = this.startedAt;
  }

  runStarted() {
    this.checkpoint("run.started");
  }

  checkpoint(event: string, fields: Record<string, LogFieldValue> = {}) {
    this.write("log", event, fields);
  }

  warning(event: string, fields: Record<string, LogFieldValue> = {}) {
    this.write("warn", event, fields);
  }

  failure(event: string, fields: Record<string, LogFieldValue> = {}) {
    this.write("error", event, fields);
  }

  firstNotification(method: string) {
    if (this.firstNotificationSeen) return;
    this.firstNotificationSeen = true;
    this.checkpoint("first.notification", { method });
  }

  firstVisibleEvent(type: string) {
    if (this.firstVisibleEventSeen) return;
    this.firstVisibleEventSeen = true;
    this.checkpoint("first.visible_event", { type });
  }

  private write(
    level: LogLevel,
    event: string,
    fields: Record<string, LogFieldValue>
  ) {
    const at = this.now();
    const elapsed = Math.max(0, Math.round(at - this.startedAt));
    const delta = Math.max(0, Math.round(at - this.lastAt));
    this.lastAt = at;

    const fieldText = this.formatFields({
      thread: this.options.threadId,
      run: this.options.runId,
      ...fields,
    });
    const suffix = fieldText ? ` ${fieldText}` : "";
    const timestamp = new Date(at).toISOString();
    const message =
      `[CodexAgent] ${timestamp} ${event}${suffix}` +
      ` +${elapsed}ms delta=${delta}ms`;
    const target = this.logger[level] ?? this.logger.log ?? console.log;

    target(message);
  }

  private formatFields(fields: Record<string, LogFieldValue>) {
    return Object.entries(fields)
      .flatMap(([key, value]) => {
        if (value === undefined || value === null || value === "") return [];
        return [`${key}=${this.formatValue(value)}`];
      })
      .join(" ");
  }

  private formatValue(value: Exclude<LogFieldValue, undefined | null>) {
    const raw = String(value);
    if (/^[\w./:-]+$/.test(raw)) return raw;
    return JSON.stringify(raw.slice(0, 120));
  }
}
