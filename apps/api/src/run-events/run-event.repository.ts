import { Injectable } from "@nestjs/common";
import { generateId } from "@agework/shared";
import type {
  RecordRunEventInput,
  RunEventData,
  RunEventRecord,
  RunEventRefs,
} from "@agework/shared/protocol";
import type { Prisma, RunEvent } from "../../generated/prisma/client.js";
import { PrismaService } from "../prisma/prisma.service";
import { redactLogValue } from "../common/logging";

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

  async listAdminEvents(params: {
    runId: string;
    type?: string[];
    typePrefix?: string;
    origin?: string[];
    targetType?: string;
    targetId?: string;
    chainId?: string;
    refKey?: string;
    refValue?: string;
    fromRunSeq?: number;
    toRunSeq?: number;
    take: number;
    skip: number;
  }) {
    const {
      runId,
      type,
      typePrefix,
      origin,
      targetType,
      targetId,
      chainId,
      refKey,
      refValue,
      fromRunSeq,
      toRunSeq,
      take,
      skip,
    } = params;
    const typeFilter: Prisma.StringFilter = {};
    if (type?.length) typeFilter.in = type;
    if (typePrefix) typeFilter.startsWith = typePrefix;
    const where: Prisma.RunEventWhereInput = {
      runId,
      ...(Object.keys(typeFilter).length ? { type: typeFilter } : {}),
      ...(origin?.length ? { origin: { in: origin } } : {}),
      ...(targetType ? { targetType } : {}),
      ...(targetId ? { targetId } : {}),
      ...(chainId ? { chainId } : {}),
      ...(fromRunSeq || toRunSeq
        ? {
            runSeq: {
              ...(fromRunSeq ? { gte: fromRunSeq } : {}),
              ...(toRunSeq ? { lte: toRunSeq } : {}),
            },
          }
        : {}),
    };

    if (refKey && refValue) {
      // refs 是 JSON 列；SQLite 无原生 JSON 过滤，这里先按 where 拉到内存线性过滤。
      // 触发升级：迁移到 Postgres 后，改用 refs @> '{"key":"value"}' 下推到 DB，
      // 去掉 hasRefValue 内存过滤与全量 findMany。
      const all = await this.prisma.runEvent.findMany({
        where,
        orderBy: [{ runSeq: "asc" }, { id: "asc" }],
      });
      const filtered = all.filter((event) =>
        hasRefValue(event.refs, refKey, refValue)
      );
      return {
        list: filtered.slice(skip, skip + take),
        total: filtered.length,
        pageNo: skip / take + 1,
        pageSize: take,
      };
    }

    const [list, total] = await Promise.all([
      this.prisma.runEvent.findMany({
        where,
        orderBy: [{ runSeq: "asc" }, { id: "asc" }],
        take,
        skip,
      }),
      this.prisma.runEvent.count({ where }),
    ]);

    return {
      list,
      total,
      pageNo: skip / take + 1,
      pageSize: take,
    };
  }
}

function hasRefValue(
  refs: Prisma.JsonValue,
  refKey: string,
  refValue: string
): boolean {
  if (!refs || typeof refs !== "object" || Array.isArray(refs)) return false;
  return (refs as RunEventRefs)[refKey as keyof RunEventRefs] === refValue;
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
