import { describe, it, expect } from "vitest";
import { validate } from "class-validator";
import { WorkerEventPostBodyDto } from "./worker-event-post-body.dto";

function toDto(body: Record<string, unknown>): WorkerEventPostBodyDto {
  return Object.assign(new WorkerEventPostBodyDto(), body);
}

describe("WorkerEventPostBodyDto", () => {
  it("accepts a JSON-RPC notification", async () => {
    const errors = await validate(
      toDto({
        jsonrpc: "2.0",
        method: "run.status",
        params: { runId: "run-1", status: { status: "running" } },
        meta: { runId: "run-1", seq: 1, ts: "2026-06-27T00:00:00.000Z" },
      })
    );
    expect(errors).toHaveLength(0);
  });

  it("accepts a JSON-RPC command-result response", async () => {
    const errors = await validate(
      toDto({
        jsonrpc: "2.0",
        id: "cmd-1",
        result: { ok: true, commandType: "cancel" },
        meta: { seq: 3, ts: "2026-06-27T00:00:00.000Z" },
      })
    );
    expect(errors).toHaveLength(0);
  });

  it("rejects legacy message-shaped bodies", async () => {
    const errors = await validate(
      toDto({
        runId: "run-1",
        seq: 1,
        type: "agui.event",
        payload: {},
        ts: "2026-06-27T00:00:00.000Z",
      })
    );
    expect(errors.length).toBeGreaterThan(0);
  });

  it("rejects a body missing jsonrpc", async () => {
    const errors = await validate(toDto({ method: "run.status" }));
    expect(errors.length).toBeGreaterThan(0);
  });

  it("rejects an unrecognized method", async () => {
    const errors = await validate(toDto({ jsonrpc: "2.0", method: "unknown" }));
    expect(errors.length).toBeGreaterThan(0);
  });

  it("rejects a JSON-RPC response that is not a command result", async () => {
    const errors = await validate(
      toDto({ jsonrpc: "2.0", id: "cmd-1", result: { ok: true } })
    );
    expect(errors.length).toBeGreaterThan(0);
  });
});
