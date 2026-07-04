import { describe, it, expect } from "vitest";
import { WorkerEventPostBodyDto } from "../dto/worker-event-post-body.dto";
import { parseWorkerEventPostBody } from "./worker-event.parser";

/**
 * class-transformer + `useDefineForClassFields` 让 DTO 实例上每个声明字段都是
 * "始终存在"的 own property（值为 undefined），即使原始 JSON 没传这个 key。
 * 用真实 DTO 实例（而不是干净 plain object）复现这个幽灵 key 问题。
 */
function toDto(body: Record<string, unknown>): WorkerEventPostBodyDto {
  return Object.assign(new WorkerEventPostBodyDto(), body);
}

describe("parseWorkerEventPostBody", () => {
  it("parses a notification even when the body carries ghost undefined keys", () => {
    const body = toDto({
      jsonrpc: "2.0",
      method: "run.status",
      params: { runId: "run-1", status: { status: "running" } },
      meta: { runId: "run-1", seq: 1, ts: "2026-06-27T00:00:00.000Z" },
    });
    expect("id" in body).toBe(true);
    expect(body.id).toBeUndefined();

    const result = parseWorkerEventPostBody(body, "run-1");

    expect(result).toBeDefined();
    expect(result).toHaveLength(1);
    expect(result?.[0]?.runId).toBe("run-1");
  });

  it("parses a command-result response even when the body carries ghost undefined keys", () => {
    const body = toDto({
      jsonrpc: "2.0",
      id: "cmd-1",
      result: { ok: true, commandType: "cancel" },
      meta: { runId: "run-1", seq: 3, ts: "2026-06-27T00:00:00.000Z" },
    });
    expect("method" in body).toBe(true);
    expect(body.method).toBeUndefined();

    const result = parseWorkerEventPostBody(body, "run-1");

    expect(result).toBeDefined();
    expect(result).toHaveLength(1);
  });

  it("still parses a clean plain object without ghost keys (regression guard)", () => {
    const body = {
      jsonrpc: "2.0",
      method: "run.status",
      params: { runId: "run-1", status: { status: "running" } },
      meta: { runId: "run-1", seq: 1, ts: "2026-06-27T00:00:00.000Z" },
    };

    const result = parseWorkerEventPostBody(body, "run-1");

    expect(result).toBeDefined();
    expect(result).toHaveLength(1);
    expect(result?.[0]?.runId).toBe("run-1");
  });

  it("returns undefined for a body that matches neither shape", () => {
    const result = parseWorkerEventPostBody({ foo: "bar" }, "run-1");
    expect(result).toBeUndefined();
  });
});
