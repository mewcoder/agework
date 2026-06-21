import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { UpstreamMessage } from "@agework/shared/protocol";
import { AgentEventTraceWriter } from "./agent-event-trace";

describe("AgentEventTraceWriter", () => {
  it("emits redacted raw SDK trace envelopes", () => {
    const emit = vi.fn<(msg: UpstreamMessage) => void>();
    const writer = new AgentEventTraceWriter(
      {
        enabled: true,
        rawFilePath: "/tmp/conversation-1.raw.jsonl",
        aguiFilePath: "/tmp/conversation-1.agui.jsonl",
        maxFileMb: 1,
        runId: "run-1",
        conversationId: "conversation-1",
        workspaceId: "ws-1",
        agentType: "codex",
      },
      emit
    );
    const circular: Record<string, unknown> = { token: "secret-token" };
    circular.self = circular;

    writer.writeSdkRaw({
      name: "sdk.codex.output",
      runId: "run-1",
      threadId: "conversation-1",
      payload: {
        message: "ok",
        circular,
      },
    });

    expect(emit).toHaveBeenCalledWith({
      runId: "run-1",
      seq: 0,
      type: "sdk.raw",
      ts: "",
      payload: {
        name: "sdk.codex.output",
        runId: "run-1",
        threadId: "conversation-1",
        conversationId: "conversation-1",
        workspaceId: "ws-1",
        agentType: "codex",
        payload: {
          message: "ok",
          circular: {
            token: "[redacted]",
            self: "[circular]",
          },
        },
      },
    });
  });

  it("writes raw SDK trace directly when runtime file path is available", () => {
    const dir = mkdtempSync(join(tmpdir(), "agework-agent-raw-"));
    const filePath = join(dir, "conversation-1.raw.jsonl");
    const emit = vi.fn<(msg: UpstreamMessage) => void>();
    const writer = new AgentEventTraceWriter(
      {
        enabled: true,
        rawFilePath: filePath,
        rawRuntimeFilePath: filePath,
        aguiFilePath: join(dir, "conversation-1.agui.jsonl"),
        maxFileMb: 1,
        runId: "run-1",
        conversationId: "conversation-1",
        workspaceId: "ws-1",
        agentType: "codex",
      },
      emit
    );

    try {
      writer.writeSdkRaw({
        name: "sdk.codex.output",
        runId: "run-1",
        threadId: "conversation-1",
        payload: { authorization: "Bearer secret", message: "ok" },
      });

      expect(emit).not.toHaveBeenCalled();
      const line = JSON.parse(readFileSync(filePath, "utf8").trim());
      expect(line).toMatchObject({
        source: "sdk.raw",
        name: "sdk.codex.output",
        runId: "run-1",
        conversationId: "conversation-1",
      });
      expect(line.payload.payload.authorization).toBe("[redacted]");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
