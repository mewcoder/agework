import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  registerWorkerRunLog,
  resetWorkerLogForTests,
  setWorkerLogContext,
  unregisterWorkerRunLog,
  workerLog,
} from "./worker-log";

describe("workerLog", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    resetWorkerLogForTests();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("filters debug logs and redacts secrets", () => {
    const dir = mkdtempSync(join(tmpdir(), "agework-worker-log-"));
    tempDirs.push(dir);
    const filePath = join(dir, "worker.log");
    vi.stubEnv("AGEWORK_INTERNAL_WORKER_LOG_FILE", filePath);
    vi.stubEnv("AGEWORK_WORKER_LOG_LEVEL", "info");
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

    workerLog("debug message", { token: "secret" }, "debug");
    workerLog("info message", { authorization: "Bearer secret" }, "info");

    const content = readFileSync(filePath, "utf8");
    expect(content).not.toContain("debug message");
    expect(content).toContain("info message");
    expect(content).toContain("[redacted]");
    expect(content).not.toContain("Bearer secret");
    expect(consoleLog).toHaveBeenCalledTimes(1);
  });

  it("adds shared context and copies run logs to the conversation file", () => {
    const dir = mkdtempSync(join(tmpdir(), "agework-worker-log-"));
    tempDirs.push(dir);
    const runtimeFilePath = join(dir, "runtime.worker.log");
    const conversationFilePath = join(dir, "conversation-1.worker.log");
    vi.stubEnv("AGEWORK_INTERNAL_WORKER_LOG_FILE", runtimeFilePath);
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

    setWorkerLogContext({ runtimeScopeKey: "ws-1" });
    registerWorkerRunLog({
      runId: "run-1",
      conversationId: "conversation-1",
      filePath: conversationFilePath,
    });
    workerLog("run message", { runId: "run-1", step: "start" }, "info");
    unregisterWorkerRunLog("run-1");
    workerLog("runtime message", { step: "poll" }, "info");

    const runtimeContent = readFileSync(runtimeFilePath, "utf8");
    const conversationContent = readFileSync(conversationFilePath, "utf8");
    expect(runtimeContent).toContain("run message");
    expect(runtimeContent).toContain("runtime message");
    expect(runtimeContent).toContain('"runtimeScopeKey":"ws-1"');
    expect(conversationContent).toContain("run message");
    expect(conversationContent).not.toContain("runtime message");
    expect(consoleLog).toHaveBeenCalledTimes(2);
  });

  it("writes each file line as parseable JSON with time/level/message", () => {
    const dir = mkdtempSync(join(tmpdir(), "agework-worker-log-"));
    tempDirs.push(dir);
    const filePath = join(dir, "worker.log");
    vi.stubEnv("AGEWORK_INTERNAL_WORKER_LOG_FILE", filePath);
    vi.spyOn(console, "log").mockImplementation(() => {});

    workerLog("structured message", { runId: "run-1", seq: 3, source: "transport" }, "info");

    const lines = readFileSync(filePath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]);
    expect(record).toMatchObject({
      level: "info",
      message: "structured message",
      runId: "run-1",
      seq: 3,
      source: "transport",
    });
    expect(typeof record.time).toBe("string");
  });

  it("stops writing and marks the file truncated once it exceeds the size limit", () => {
    const dir = mkdtempSync(join(tmpdir(), "agework-worker-log-"));
    tempDirs.push(dir);
    const filePath = join(dir, "worker.log");
    vi.stubEnv("AGEWORK_INTERNAL_WORKER_LOG_FILE", filePath);
    vi.stubEnv("AGEWORK_WORKER_LOG_MAX_FILE_MB", "1");
    vi.spyOn(console, "log").mockImplementation(() => {});

    writeFileSync(filePath, `${JSON.stringify({ message: "x".repeat(1024 * 1024) })}\n`);
    workerLog("over limit message", undefined, "info");
    workerLog("over limit message again", undefined, "info");

    const content = readFileSync(filePath, "utf8");
    expect(content).not.toContain("over limit message");
    const lines = content.trim().split("\n");
    const markerLines = lines.filter((line) => line.includes('"eventType":"log.truncated"'));
    expect(markerLines).toHaveLength(1);
    const marker = JSON.parse(markerLines[0]);
    expect(marker).toMatchObject({
      level: "warn",
      message: "worker log truncated: reached size limit",
      source: "worker",
      eventType: "log.truncated",
    });
  });
});
