import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import type { Prisma } from "../../../generated/prisma/client.js";
import { PrismaService } from "../../prisma/prisma.service";
import { errorLogFields, redactLogValue, safeLogJson } from "../../common/logging";

const MAX_QUEUE_SIZE = 2_000;
const BATCH_SIZE = 100;
const FLUSH_INTERVAL_MS = 500;
const MAX_SUMMARY_LENGTH = 500;
const MAX_PAYLOAD_JSON_LENGTH = 8_000;

export type RunTraceEventLevel = "debug" | "info" | "warn" | "error";
export type RunTraceEventSource =
  | "agui"
  | "sdk"
  | "runtime"
  | "control"
  | "system";

export type RunTraceEventInput = {
  runId: string;
  seq?: number;
  source: RunTraceEventSource;
  eventType: string;
  level?: RunTraceEventLevel;
  summary?: string;
  payload?: unknown;
  payloadRef?: string;
};

type RunTraceEventRow = {
  runId: string;
  seq?: number;
  source: string;
  eventType: string;
  level: string;
  summary?: string;
  payload?: unknown;
  payloadRef?: string;
};

@Injectable()
export class RunEventRecordService implements OnModuleDestroy {
  private readonly logger = new Logger(RunEventRecordService.name);
  private readonly queue: RunTraceEventRow[] = [];
  private flushTimer: NodeJS.Timeout | undefined;
  private flushing = false;

  constructor(private readonly prisma: PrismaService) {}

  record(input: RunTraceEventInput): void {
    const row = normalizeEvent(input);
    if (this.queue.length >= MAX_QUEUE_SIZE) {
      const debugIndex = this.queue.findIndex((item) => item.level === "debug");
      if (debugIndex >= 0) {
        this.queue.splice(debugIndex, 1);
      } else if (row.level === "debug") {
        return;
      } else {
        this.queue.shift();
      }
    }

    this.queue.push(row);
    this.scheduleFlush();
  }

  async flush(): Promise<void> {
    if (this.flushing || this.queue.length === 0) return;
    this.flushing = true;
    try {
      while (this.queue.length > 0) {
        const batch = this.queue.splice(0, BATCH_SIZE);
        await this.prisma.runEvent.createMany({
          data: batch.map((event) => {
            const data: Prisma.RunEventCreateManyInput = {
              runId: event.runId,
              source: event.source,
              eventType: event.eventType,
              level: event.level,
            };
            if (event.seq !== undefined) data.seq = event.seq;
            if (event.summary !== undefined) data.summary = event.summary;
            if (event.payload !== undefined) {
              data.payload = event.payload as Prisma.InputJsonValue;
            }
            if (event.payloadRef !== undefined) data.payloadRef = event.payloadRef;
            return data;
          }),
        });
      }
    } catch (err) {
      this.logger.warn(
        `flush run events failed ${safeLogJson(errorLogFields(err))}`
      );
    } finally {
      this.flushing = false;
      if (this.queue.length > 0) this.scheduleFlush();
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    await this.flush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.flush().catch((err) =>
        this.logger.warn(`run event flush failed ${String(err)}`)
      );
    }, FLUSH_INTERVAL_MS);
    this.flushTimer.unref();
  }
}

function normalizeEvent(
  input: RunTraceEventInput
): RunTraceEventRow {
  return {
    runId: input.runId,
    seq: input.seq,
    source: input.source,
    eventType: input.eventType,
    level: input.level ?? "info",
    summary: truncate(input.summary, MAX_SUMMARY_LENGTH),
    payload: normalizePayload(input.payload),
    payloadRef: input.payloadRef,
  };
}

function normalizePayload(payload: unknown): unknown {
  if (payload === undefined) return undefined;
  const redacted = redactLogValue(payload);
  try {
    const json = JSON.stringify(redacted);
    if (json.length > MAX_PAYLOAD_JSON_LENGTH) {
      return {
        truncated: true,
        bytes: json.length,
        preview: json.slice(0, MAX_PAYLOAD_JSON_LENGTH),
      };
    }
  } catch {
    return String(redacted);
  }
  return redacted;
}

function truncate(value: string | undefined, maxLength: number): string | undefined {
  if (!value || value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}...`;
}
