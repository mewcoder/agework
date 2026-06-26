import { Injectable } from "@nestjs/common";
import { generateId } from "@agework/shared";
import type {
  RecordRunEventInput,
  RunEventData,
  RunEventRecord,
  RunEventRefs,
} from "@agework/shared/protocol";
import type { Prisma, RunEvent } from "../../../generated/prisma/client.js";
import { PrismaService } from "../../prisma/prisma.service";
import { redactLogValue } from "../../common/logging";

const MAX_SUMMARY_LENGTH = 500;
const MAX_DATA_JSON_LENGTH = 8_000;

export type RunEventCreateInput = RecordRunEventInput & {
  runSeq: number;
};

@Injectable()
export class RunEventRepository {
  constructor(private readonly prisma: PrismaService) {}

  async maxRunSeq(runId: string): Promise<number> {
    const latest = await this.prisma.runEvent.findFirst({
      where: { runId },
      orderBy: { runSeq: "desc" },
      select: { runSeq: true },
    });
    return latest?.runSeq ?? 0;
  }

  async insertOrGetByEventKey(
    input: RunEventCreateInput
  ): Promise<RunEventRecord> {
    try {
      const row = await this.prisma.runEvent.create({
        data: toPrismaCreateInput(normalizeCreateInput(input)),
      });
      return toRunEventRecord(row);
    } catch (err) {
      if (input.eventKey && isPrismaUniqueError(err)) {
        const existing = await this.prisma.runEvent.findFirst({
          where: { runId: input.runId, eventKey: input.eventKey },
        });
        if (existing) return toRunEventRecord(existing);
      }
      throw err;
    }
  }
}

function normalizeCreateInput(input: RunEventCreateInput): RunEventCreateInput {
  return {
    ...input,
    summary: truncate(input.summary, MAX_SUMMARY_LENGTH),
    refs: normalizeRefs(input.refs),
    data: normalizeData(input.data),
  };
}

function normalizeRefs(refs: RunEventRefs | undefined): RunEventRefs | undefined {
  if (!refs) return undefined;
  const output: RunEventRefs = {};
  for (const [key, value] of Object.entries(refs)) {
    if (typeof value === "string" && value.length > 0) {
      output[key as keyof RunEventRefs] = value;
    }
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

function normalizeData(data: RunEventData | undefined): RunEventData | undefined {
  if (data === undefined) return undefined;
  const redacted = redactLogValue(data) as RunEventData;
  try {
    const json = JSON.stringify(redacted);
    if (json.length > MAX_DATA_JSON_LENGTH) {
      return {
        truncated: true,
        bytes: json.length,
        preview: json.slice(0, MAX_DATA_JSON_LENGTH),
      };
    }
  } catch {
    return { value: String(redacted) };
  }
  return redacted;
}

function toPrismaCreateInput(
  input: RunEventCreateInput
): Prisma.RunEventUncheckedCreateInput {
  const data: Prisma.RunEventUncheckedCreateInput = {
    id: generateId(),
    runId: input.runId,
    runSeq: input.runSeq,
    type: input.type,
    origin: input.origin,
  };
  if (input.eventKey !== undefined) data.eventKey = input.eventKey;
  if (input.targetType !== undefined) data.targetType = input.targetType;
  if (input.targetId !== undefined) data.targetId = input.targetId;
  if (input.chainId !== undefined) data.chainId = input.chainId;
  if (input.refs !== undefined) data.refs = input.refs as Prisma.InputJsonValue;
  if (input.summary !== undefined) data.summary = input.summary;
  if (input.data !== undefined) data.data = input.data as Prisma.InputJsonValue;
  return data;
}

function toRunEventRecord(row: RunEvent): RunEventRecord {
  return {
    id: row.id,
    runId: row.runId,
    runSeq: row.runSeq,
    eventKey: row.eventKey,
    type: row.type,
    origin: row.origin as RunEventRecord["origin"],
    targetType: row.targetType as RunEventRecord["targetType"],
    targetId: row.targetId,
    chainId: row.chainId,
    refs: row.refs as RunEventRefs | null,
    summary: row.summary,
    data: row.data as RunEventData | null,
    createdAt: row.createdAt.toISOString(),
  };
}

function isPrismaUniqueError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "P2002"
  );
}

function truncate(value: string | undefined, maxLength: number): string | undefined {
  if (!value || value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}...`;
}
