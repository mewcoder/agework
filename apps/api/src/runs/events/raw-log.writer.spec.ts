import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RawEventLogWriter } from "./raw-event-log.writer";

describe("RawEventLogWriter", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes raw and AGUI events to separate conversation-level files", () => {
    const dir = mkdtempSync(join(tmpdir(), "agework-agent-events-"));
    tempDirs.push(dir);
    const rawFilePath = join(dir, "conversation-1.raw.jsonl");
    const aguiFilePath = join(dir, "conversation-1.agui.jsonl");
    const service = new RawEventLogWriter();
    const config = {
      enabled: true,
      rawFilePath,
      aguiFilePath,
      maxFileMb: 1,
      runId: "run-1",
      conversationId: "conversation-1",
      workspaceId: "ws-1",
      agentType: "codex",
    };

    service.writeRaw(config, {
      name: "sdk.codex.output",
      runId: "run-1",
      threadId: "conversation-1",
      payload: { message: "ok", apiKey: "secret-key" },
    });
    service.writeAgui(config, {
      type: "TEXT_MESSAGE_CHUNK",
      delta: "hi",
      token: "secret-token",
    });

    const raw = JSON.parse(readFileSync(rawFilePath, "utf8").trim());
    const agui = JSON.parse(readFileSync(aguiFilePath, "utf8").trim());

    expect(raw).toMatchObject({
      source: "sdk.raw",
      name: "sdk.codex.output",
      runId: "run-1",
      conversationId: "conversation-1",
      workspaceId: "ws-1",
      agentType: "codex",
      payload: {
        runId: "run-1",
        threadId: "conversation-1",
        payload: { message: "ok", apiKey: "[redacted]" },
      },
    });
    expect(agui).toMatchObject({
      source: "agui.event",
      name: "TEXT_MESSAGE_CHUNK",
      runId: "run-1",
      conversationId: "conversation-1",
      workspaceId: "ws-1",
      agentType: "codex",
      payload: {
        type: "TEXT_MESSAGE_CHUNK",
        delta: "hi",
        token: "[redacted]",
      },
    });
  });
});
