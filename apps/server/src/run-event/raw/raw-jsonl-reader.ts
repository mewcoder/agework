import { Injectable } from "@nestjs/common";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigService } from "../../config/config.service";
import { safePathPart } from "../../common/safe-path";

export type RawJsonlChannel = "sdk.raw" | "agui.event";

export type RawJsonlLine = {
  ts: string;
  source: string;
  name: string;
  runId?: string;
  [key: string]: unknown;
};

const CHANNEL_FILE_SUFFIX: Record<RawJsonlChannel, string> = {
  "sdk.raw": "raw",
  "agui.event": "agui",
};

/**
 * 按 conversation 读取 worker 侧 TraceLogWriter 写入的 raw/agui JSONL 流水（本地文件，
 * 不进 DB）。只读诊断:不做索引、不做增量 tail，线性扫描 + 内存过滤，配合
 * §9.4 的单文件大小上限兜住规模。
 */
@Injectable()
export class RawJsonlReader {
  constructor(private readonly configService: ConfigService) {}

  /** 按 run 过滤指定 channel 的 raw JSONL 行，管理端诊断用。分页信封由 RunEventService 收口。 */
  listForAdmin(params: {
    runId: string;
    conversationId: string;
    channel?: RawJsonlChannel[];
    take: number;
    skip: number;
  }): { list: RawJsonlLine[]; total: number } {
    const { runId, conversationId, channel, take, skip } = params;
    const channels = channel?.length
      ? channel
      : (["sdk.raw", "agui.event"] as RawJsonlChannel[]);
    // 多个 channel 各自是文件内写入顺序（等价按时间递增），但 flatMap 只是把整份
    // channel 文件依次拼接，不是按时间合并；必须显式按 ts 排序才是一条真正的
    // 跨 channel 时间线。
    const lines = channels
      .flatMap((c) => this.readChannel(conversationId, c))
      .filter((line) => line.runId === runId)
      .sort((a, b) => a.ts.localeCompare(b.ts));

    return { list: lines.slice(skip, skip + take), total: lines.length };
  }

  private readChannel(
    conversationId: string,
    channel: RawJsonlChannel
  ): RawJsonlLine[] {
    const fileName = `${safePathPart(conversationId)}.${CHANNEL_FILE_SUFFIX[channel]}.jsonl`;
    const filePath = join(this.configService.getRuntimeLogDir(), fileName);
    if (!existsSync(filePath)) return [];

    const result: RawJsonlLine[] = [];
    for (const rawLine of readFileSync(filePath, "utf-8").split("\n")) {
      if (!rawLine.trim()) continue;
      try {
        result.push(JSON.parse(rawLine) as RawJsonlLine);
      } catch {
        // 单行损坏(如写入中途被截断)跳过，不影响其余行读取。
      }
    }
    return result;
  }
}
