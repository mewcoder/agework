import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConfigService } from "../../config/config.service";
import { RawJsonlReader } from "./raw-jsonl-reader";

describe("RawJsonlReader", () => {
  let logDir: string;
  let reader: RawJsonlReader;

  beforeEach(() => {
    logDir = mkdtempSync(join(tmpdir(), "raw-jsonl-reader-test-"));
    const configService = {
      getRuntimeLogDir: () => logDir,
    } as ConfigService;
    reader = new RawJsonlReader(configService);
  });

  afterEach(() => {
    rmSync(logDir, { recursive: true, force: true });
  });

  it("returns empty result when no trace file exists for the conversation", () => {
    const result = reader.listForAdmin({
      runId: "run-1",
      conversationId: "conversation-missing",
      take: 10,
      skip: 0,
    });

    // 分页信封由 RunEventService 收口;reader 只回 list/total。
    expect(result).toEqual({ list: [], total: 0 });
  });

  it("reads and filters raw + agui lines by runId across both channels", () => {
    writeFileSync(
      join(logDir, "conversation-1.raw.jsonl"),
      [
        JSON.stringify({
          ts: "t1",
          source: "sdk.raw",
          name: "a",
          runId: "run-1",
        }),
        JSON.stringify({
          ts: "t2",
          source: "sdk.raw",
          name: "b",
          runId: "run-2",
        }),
      ].join("\n") + "\n"
    );
    writeFileSync(
      join(logDir, "conversation-1.agui.jsonl"),
      JSON.stringify({
        ts: "t3",
        source: "agui.event",
        name: "TOOL_CALL_START",
        runId: "run-1",
      }) + "\n"
    );

    const result = reader.listForAdmin({
      runId: "run-1",
      conversationId: "conversation-1",
      take: 10,
      skip: 0,
    });

    expect(result.total).toBe(2);
    expect(result.list.map((line) => line.name)).toEqual([
      "a",
      "TOOL_CALL_START",
    ]);
  });

  it("interleaves lines across channels by timestamp, not by channel order", () => {
    writeFileSync(
      join(logDir, "conversation-1.raw.jsonl"),
      JSON.stringify({
        ts: "2026-07-07T00:00:02.000Z",
        source: "sdk.raw",
        name: "later-raw",
        runId: "run-1",
      }) + "\n"
    );
    writeFileSync(
      join(logDir, "conversation-1.agui.jsonl"),
      JSON.stringify({
        ts: "2026-07-07T00:00:01.000Z",
        source: "agui.event",
        name: "earlier-agui",
        runId: "run-1",
      }) + "\n"
    );

    const result = reader.listForAdmin({
      runId: "run-1",
      conversationId: "conversation-1",
      take: 10,
      skip: 0,
    });

    // channels 参数默认顺序是 [sdk.raw, agui.event]，如果只是拼接文件而不按 ts
    // 排序，"later-raw" 会排在 "earlier-agui" 前面——这里验证的正是排序生效。
    expect(result.list.map((line) => line.name)).toEqual([
      "earlier-agui",
      "later-raw",
    ]);
  });

  it("filters by a single channel when requested", () => {
    writeFileSync(
      join(logDir, "conversation-1.raw.jsonl"),
      JSON.stringify({
        ts: "t1",
        source: "sdk.raw",
        name: "a",
        runId: "run-1",
      }) + "\n"
    );
    writeFileSync(
      join(logDir, "conversation-1.agui.jsonl"),
      JSON.stringify({
        ts: "t2",
        source: "agui.event",
        name: "TOOL_CALL_START",
        runId: "run-1",
      }) + "\n"
    );

    const result = reader.listForAdmin({
      runId: "run-1",
      conversationId: "conversation-1",
      channel: ["agui.event"],
      take: 10,
      skip: 0,
    });

    expect(result.list).toHaveLength(1);
    expect(result.list[0].name).toBe("TOOL_CALL_START");
  });

  it("skips malformed lines without throwing", () => {
    writeFileSync(
      join(logDir, "conversation-1.raw.jsonl"),
      [
        "not json",
        JSON.stringify({
          ts: "t1",
          source: "sdk.raw",
          name: "a",
          runId: "run-1",
        }),
      ].join("\n") + "\n"
    );

    const result = reader.listForAdmin({
      runId: "run-1",
      conversationId: "conversation-1",
      channel: ["sdk.raw"],
      take: 10,
      skip: 0,
    });

    expect(result.list).toHaveLength(1);
  });

  it("paginates within the filtered result set", () => {
    const lines = Array.from({ length: 5 }, (_, i) =>
      JSON.stringify({
        ts: `t${i}`,
        source: "sdk.raw",
        name: `n${i}`,
        runId: "run-1",
      })
    );
    writeFileSync(
      join(logDir, "conversation-1.raw.jsonl"),
      lines.join("\n") + "\n"
    );

    const result = reader.listForAdmin({
      runId: "run-1",
      conversationId: "conversation-1",
      channel: ["sdk.raw"],
      take: 2,
      skip: 2,
    });

    expect(result.total).toBe(5);
    expect(result.list.map((line) => line.name)).toEqual(["n2", "n3"]);
  });
});
