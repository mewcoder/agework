import { Injectable } from "@nestjs/common";
import type { RunEventRefs } from "@agework/shared/protocol";
import { Prisma } from "../../../generated/prisma/client.js";
import { PrismaService } from "../../prisma/prisma.service";

function hasRefValue(
  refs: Prisma.JsonValue,
  refKey: string,
  refValue: string
): boolean {
  if (!refs || typeof refs !== "object" || Array.isArray(refs)) return false;
  return (refs as RunEventRefs)[refKey as keyof RunEventRefs] === refValue;
}

@Injectable()
export class RunEventQuery {
  constructor(private prisma: PrismaService) {}

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
      // SQLite JSON filtering is kept as a linear admin-only scan for now.
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
