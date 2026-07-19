import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TraceLogWriter } from "./trace";

describe("TraceLogWriter", () => {
  it("is disabled when no runtime trace file path is available", () => {
    const writer = new TraceLogWriter({
      enabled: true,
      rawFilePath: "/tmp/conversation-1.raw.jsonl",
      aguiFilePath: "/tmp/conversation-1.agui.jsonl",
      maxFileMb: 1,
      runId: "run-1",
      conversationId: "conversation-1",
      workspaceId: "ws-1",
      agentType: "codex",
    });

    expect(writer.enabled).toBe(false);
    expect(writer.sink()).toBeUndefined();
  });

  it("writes raw SDK trace directly when runtime file path is available", () => {
    const dir = mkdtempSync(join(tmpdir(), "agework-agent-raw-"));
    const filePath = join(dir, "conversation-1.raw.jsonl");
    const writer = new TraceLogWriter({
      enabled: true,
      rawFilePath: filePath,
      rawRuntimeFilePath: filePath,
      aguiFilePath: join(dir, "conversation-1.agui.jsonl"),
      maxFileMb: 1,
      runId: "run-1",
      conversationId: "conversation-1",
      workspaceId: "ws-1",
      agentType: "codex",
    });

    try {
      writer.writeSdkRaw({
        name: "sdk.codex.output",
        runId: "run-1",
        threadId: "conversation-1",
        payload: { authorization: "Bearer secret", message: "ok" },
      });

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

  it("writes AG-UI trace directly when runtime file path is available", () => {
    const dir = mkdtempSync(join(tmpdir(), "agework-agent-agui-"));
    const filePath = join(dir, "conversation-1.agui.jsonl");
    const writer = new TraceLogWriter({
      enabled: true,
      rawFilePath: join(dir, "conversation-1.raw.jsonl"),
      aguiFilePath: filePath,
      aguiRuntimeFilePath: filePath,
      maxFileMb: 1,
      runId: "run-1",
      conversationId: "conversation-1",
      workspaceId: "ws-1",
      agentType: "codex",
    });

    try {
      writer.writeAgui({
        type: "TEXT_MESSAGE_CONTENT",
        delta: "hello",
        authorization: "Bearer secret",
      });

      const line = JSON.parse(readFileSync(filePath, "utf8").trim());
      expect(line).toMatchObject({
        source: "agui.event",
        name: "TEXT_MESSAGE_CONTENT",
        runId: "run-1",
        conversationId: "conversation-1",
        payload: {
          type: "TEXT_MESSAGE_CONTENT",
          delta: "hello",
          authorization: "[redacted]",
        },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
