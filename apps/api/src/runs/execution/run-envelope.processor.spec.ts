import { describe, it, expect, vi, beforeEach } from "vitest";
import { RunEnvelopeProcessor } from "./run-envelope.processor";
import { RunRepository } from "../run.repository";
import { RunActiveStore } from "./run-active.store";
import { ConversationService } from "../../conversations/conversation.service";
import { RunMessageAggregator } from "./run-message.aggregator";
import { RawEventLogWriter } from "../events/raw-event-log.writer";
import { RunEventRecorder } from "../events/run-event-recorder";
import { RunExecutionStatusHandler } from "./run-execution-status.handler";

describe("RunEnvelopeProcessor", () => {
  let runEventProcessor: RunEnvelopeProcessor;
  let runRegistry: RunActiveStore;
  let mockRunRepository: Partial<RunRepository>;
  let mockConversationService: Partial<ConversationService>;
  let mockRawEventLogWriter: Partial<RawEventLogWriter>;
  let mockRunEventRecorder: Partial<RunEventRecorder>;

  beforeEach(() => {
    mockRunRepository = {
      markRunning: vi.fn().mockResolvedValue(undefined),
      markFinished: vi.fn().mockResolvedValue(undefined),
      markError: vi.fn().mockResolvedValue(undefined),
      markCancelled: vi.fn().mockResolvedValue(undefined),
      markRequiresAction: vi.fn().mockResolvedValue(undefined),
      updateHeartbeat: vi.fn().mockResolvedValue(undefined),
      findActiveByConversationId: vi.fn().mockResolvedValue(null),
    };

    mockConversationService = {
      setPendingUserAction: vi.fn().mockResolvedValue(undefined),
      setActiveRunStatus: vi.fn().mockResolvedValue(undefined),
    };
    mockRawEventLogWriter = {
      writeRaw: vi.fn(),
      writeAgui: vi.fn(),
    };
    mockRunEventRecorder = {
      append: vi.fn().mockResolvedValue({} as never),
      forgetRun: vi.fn(),
    };

    runRegistry = new RunActiveStore();
    const runExecutionStatusHandler = new RunExecutionStatusHandler(
      mockRunRepository as RunRepository,
      mockConversationService as ConversationService,
      runRegistry
    );
    runEventProcessor = new RunEnvelopeProcessor(
      mockRunRepository as RunRepository,
      runRegistry,
      mockConversationService as ConversationService,
      mockRawEventLogWriter as RawEventLogWriter,
      mockRunEventRecorder as RunEventRecorder,
      runExecutionStatusHandler
    );
  });

  it("should be defined", () => {
    expect(runEventProcessor).toBeDefined();
  });

  it("should deduplicate envelopes by seq", async () => {
    const envelope = {
      runId: "run-1",
      seq: 1,
      type: "run.status" as const,
      payload: { status: "running" as const },
      ts: new Date().toISOString(),
    };

    // First publish
    await runEventProcessor.publish(envelope);
    // Second with same seq should be dropped
    await runEventProcessor.publish(envelope);

    // markRunning should only be called once
    expect(mockRunRepository.markRunning).toHaveBeenCalledTimes(1);
    expect(mockRunEventRecorder.append).toHaveBeenCalledTimes(1);
    expect(mockRunEventRecorder.append).toHaveBeenCalledWith(
      expect.objectContaining({ type: "run.status_changed" })
    );
  });

  it("should handle heartbeat envelope", async () => {
    const envelope = {
      runId: "run-1",
      seq: 1,
      type: "heartbeat" as const,
      payload: { at: new Date().toISOString() },
      ts: new Date().toISOString(),
    };

    await runEventProcessor.publish(envelope);
    expect(mockRunRepository.updateHeartbeat).toHaveBeenCalledWith("run-1");
    expect(mockRunEventRecorder.append).not.toHaveBeenCalled();
  });

  it("forceErrorStatus marks the run as error and bypasses seq dedup", async () => {
    await runEventProcessor.publish({
      runId: "run-1",
      seq: 5,
      type: "run.status" as const,
      payload: { status: "running" as const },
      ts: new Date().toISOString(),
    });

    await runEventProcessor.forceErrorStatus("run-1", "worker heartbeat timeout");

    expect(mockRunRepository.markError).toHaveBeenCalledWith(
      "run-1",
      "worker heartbeat timeout"
    );
  });

  it("still applies terminal status when run event recording fails", async () => {
    mockRunEventRecorder.append = vi
      .fn()
      .mockRejectedValue(new Error("SQLITE_BUSY"));

    await expect(
      runEventProcessor.publish({
        runId: "run-1",
        seq: 1,
        type: "run.status" as const,
        payload: { status: "finished" as const },
        ts: new Date().toISOString(),
      })
    ).resolves.toBeUndefined();

    expect(mockRunRepository.markFinished).toHaveBeenCalledWith("run-1");
  });

  it("ignores late run statuses after a terminal status", async () => {
    await runEventProcessor.publish({
      runId: "run-1",
      seq: 1,
      type: "run.status" as const,
      payload: { status: "finished" as const },
      ts: new Date().toISOString(),
    });

    expect(mockRunRepository.markFinished).toHaveBeenCalledWith("run-1");

    (mockRunRepository.markRunning as ReturnType<typeof vi.fn>).mockClear();
    (mockRunEventRecorder.append as ReturnType<typeof vi.fn>).mockClear();

    await runEventProcessor.publish({
      runId: "run-1",
      seq: 2,
      type: "run.status" as const,
      payload: { status: "running" as const },
      ts: new Date().toISOString(),
    });

    expect(mockRunRepository.markRunning).not.toHaveBeenCalled();
    expect(mockRunEventRecorder.append).not.toHaveBeenCalled();
  });

  it("continues AG-UI processing when run event recording fails", async () => {
    mockRunEventRecorder.append = vi
      .fn()
      .mockRejectedValue(new Error("SQLITE_BUSY"));
    const aggregator = { handle: vi.fn() };
    const traceConfig = {
      enabled: true,
      rawFilePath: "/tmp/conversation-1.raw.jsonl",
      aguiFilePath: "/tmp/conversation-1.agui.jsonl",
      runId: "run-1",
      conversationId: "conversation-1",
      workspaceId: "ws-1",
      agentType: "claude",
    };
    runRegistry.register("run-1", {
      runtimeHandle: { runId: "run-1", runtimeType: "local", runtimeResourceId: "1:token", conversationId: "conversation-1" },
      runId: "run-1",
      conversationId: "conversation-1",
      workspaceId: "ws-1",
      agentType: "claude",
      agentEventTrace: traceConfig,
      res: null,
      aggregator: aggregator as any,
      stopRequested: false,
      saveRun: vi.fn(),
    });

    await expect(
      runEventProcessor.publish({
        runId: "run-1",
        seq: 1,
        type: "agui.event" as const,
        payload: {
          type: "TOOL_CALL_START",
          toolCallId: "tool-1",
          toolCallName: "bash",
        },
        ts: new Date().toISOString(),
      })
    ).resolves.toBeUndefined();

    expect(mockRawEventLogWriter.writeAgui).toHaveBeenCalledWith(
      traceConfig,
      expect.objectContaining({ type: "TOOL_CALL_START" })
    );
    expect(aggregator.handle).toHaveBeenCalledWith(
      expect.objectContaining({ type: "TOOL_CALL_START" })
    );
  });

  it("should not forward MESSAGES_SNAPSHOT events to the SSE response", async () => {
    const res = { write: vi.fn(), writableEnded: false } as any;
    runRegistry.register("run-1", {
      runtimeHandle: { runId: "run-1", runtimeType: "local", runtimeResourceId: "1:token", conversationId: "conversation-1" },
      runId: "run-1",
      conversationId: "conversation-1",
      workspaceId: "ws-1",
      agentType: "claude",
      res,
      aggregator: new RunMessageAggregator(),
      stopRequested: false,
      saveRun: vi.fn(),
    });

    await runEventProcessor.publish({
      runId: "run-1",
      seq: 1,
      type: "agui.event" as const,
      payload: { type: "MESSAGES_SNAPSHOT", messages: [] },
      ts: new Date().toISOString(),
    });

    expect(res.write).not.toHaveBeenCalled();
    expect(mockRawEventLogWriter.writeAgui).toHaveBeenCalledWith(
      undefined,
      { type: "MESSAGES_SNAPSHOT", messages: [] }
    );
  });

  it("streamingSnapshot=true 推送累积快照而非原始事件", async () => {
    const res = { write: vi.fn(), writableEnded: false, end: vi.fn() } as any;
    runRegistry.register("run-1", {
      runtimeHandle: { runId: "run-1", runtimeType: "local", runtimeResourceId: "1:token", conversationId: "conversation-1" },
      runId: "run-1",
      conversationId: "conversation-1",
      workspaceId: "ws-1",
      agentType: "claude",
      res,
      aggregator: new RunMessageAggregator(),
      stopRequested: false,
      saveRun: vi.fn(),
      streamingSnapshot: true,
    });

    // RUN_STARTED + 文本开始 + 内容 + 结束
    await runEventProcessor.publish({ runId: "run-1", seq: 1, type: "agui.event", payload: { type: "RUN_STARTED", runId: "run-1" }, ts: "" });
    await runEventProcessor.publish({ runId: "run-1", seq: 2, type: "agui.event", payload: { type: "TEXT_MESSAGE_START", messageId: "m-1", role: "assistant" }, ts: "" });
    await runEventProcessor.publish({ runId: "run-1", seq: 3, type: "agui.event", payload: { type: "TEXT_MESSAGE_CONTENT", messageId: "m-1", delta: "hello" }, ts: "" });
    await runEventProcessor.publish({ runId: "run-1", seq: 4, type: "agui.event", payload: { type: "TEXT_MESSAGE_END", messageId: "m-1" }, ts: "" });

    // TEXT_MESSAGE_END 是事件边界，应推送一个含 "hello" 文本的累积快照
    const lastWrite = (res.write as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as string;
    expect(lastWrite).toContain("hello");
    expect(lastWrite.startsWith("data:")).toBe(true);
    const parsed = JSON.parse(lastWrite.slice(6).trim());
    expect(parsed.content).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "text", text: "hello" })])
    );
  });

  it("streamingSnapshot=false 走原始事件转发（回归）", async () => {
    const res = { write: vi.fn(), writableEnded: false, end: vi.fn() } as any;
    runRegistry.register("run-2", {
      runtimeHandle: { runId: "run-2", runtimeType: "local", runtimeResourceId: "2:token", conversationId: "conversation-2" },
      runId: "run-2",
      conversationId: "conversation-2",
      workspaceId: "ws-1",
      agentType: "claude",
      res,
      aggregator: new RunMessageAggregator(),
      stopRequested: false,
      saveRun: vi.fn(),
      // streamingSnapshot 默认 false
    });

    await runEventProcessor.publish({
      runId: "run-2", seq: 1, type: "agui.event",
      payload: { type: "RUN_STARTED", runId: "run-2" }, ts: "",
    });

    // 原始事件直接 JSON 转发，不是快照形态
    const written = (res.write as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as string;
    expect(written).toContain('"type":"RUN_STARTED"');
  });

  it("records failed tool results as tool.failed facts", async () => {
    runRegistry.register("run-1", {
      runtimeHandle: { runId: "run-1", runtimeType: "local", runtimeResourceId: "1:token", conversationId: "conversation-1" },
      runId: "run-1",
      conversationId: "conversation-1",
      workspaceId: "ws-1",
      agentType: "claude",
      res: null,
      aggregator: { handle: vi.fn() } as any,
      stopRequested: false,
      saveRun: vi.fn(),
    });

    await runEventProcessor.publish({
      runId: "run-1",
      seq: 1,
      type: "agui.event" as const,
      payload: {
        type: "TOOL_CALL_RESULT",
        toolCallId: "tool-1",
        messageId: "msg-1",
        isError: true,
        content: JSON.stringify({ error: "permission denied" }),
      },
      ts: new Date().toISOString(),
    });

    expect(mockRunEventRecorder.append).toHaveBeenCalledWith(
      expect.objectContaining({
        eventKey: "tool:tool-1:failed",
        type: "tool.failed",
        targetId: "tool-1",
        refs: expect.objectContaining({
          toolCallId: "tool-1",
          messageId: "msg-1",
        }),
        data: expect.objectContaining({ error: "permission denied" }),
      })
    );
    const recordedTypes = (
      mockRunEventRecorder.append as ReturnType<typeof vi.fn>
    ).mock.calls.map(([fact]) => fact.type);
    expect(recordedTypes).not.toContain("tool.completed");
  });

  it("writes raw SDK events without forwarding them to the aggregator", async () => {
    const aggregator = { handle: vi.fn() };
    const traceConfig = {
      enabled: true,
      rawFilePath: "/tmp/conversation-1.raw.jsonl",
      aguiFilePath: "/tmp/conversation-1.agui.jsonl",
      runId: "run-1",
      conversationId: "conversation-1",
      workspaceId: "ws-1",
      agentType: "claude",
    };
    runRegistry.register("run-1", {
      runtimeHandle: { runId: "run-1", runtimeType: "local", runtimeResourceId: "1:token", conversationId: "conversation-1" },
      runId: "run-1",
      conversationId: "conversation-1",
      workspaceId: "ws-1",
      agentType: "claude",
      agentEventTrace: traceConfig,
      res: null,
      aggregator: aggregator as any,
      stopRequested: false,
      saveRun: vi.fn(),
    });

    const payload = { name: "sdk.claude.output", payload: { value: "ok" } };
    await runEventProcessor.publish({
      runId: "run-1",
      seq: 1,
      type: "sdk.raw" as const,
      payload,
      ts: new Date().toISOString(),
    });

    expect(mockRawEventLogWriter.writeRaw).toHaveBeenCalledWith(
      traceConfig,
      payload
    );
    expect(aggregator.handle).not.toHaveBeenCalled();
  });
});
