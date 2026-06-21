import { describe, it, expect, vi, beforeEach } from "vitest";
import { RuntimeEventProcessor } from "./runtime-event-processor";
import { RunRecordService } from "./run-record.service";
import { RuntimeActiveStore } from "./runtime-active-store";
import { ConversationService } from "../../conversations/conversation.service";
import { RuntimeMessageAggregator } from "./runtime-message-aggregator";
import { AgentEventLogService } from "./agent-event-log.service";
import { RunEventRecordService } from "./run-event-record.service";

describe("RuntimeEventProcessor", () => {
  let runEventProcessor: RuntimeEventProcessor;
  let runRegistry: RuntimeActiveStore;
  let mockRunRecordService: Partial<RunRecordService>;
  let mockConversationService: Partial<ConversationService>;
  let mockAgentEventLogService: Partial<AgentEventLogService>;
  let mockRunEventRecordService: Partial<RunEventRecordService>;

  beforeEach(() => {
    mockRunRecordService = {
      markRunning: vi.fn().mockResolvedValue(undefined),
      markFinished: vi.fn().mockResolvedValue(undefined),
      markError: vi.fn().mockResolvedValue(undefined),
      markCancelled: vi.fn().mockResolvedValue(undefined),
      markRequiresAction: vi.fn().mockResolvedValue(undefined),
      updateHeartbeat: vi.fn().mockResolvedValue(undefined),
    };

    mockConversationService = {
      setPendingUserAction: vi.fn().mockResolvedValue(undefined),
      setActiveRunStatus: vi.fn().mockResolvedValue(undefined),
    };
    mockAgentEventLogService = {
      writeRaw: vi.fn(),
      writeAgui: vi.fn(),
    };
    mockRunEventRecordService = {
      record: vi.fn(),
    };

    runRegistry = new RuntimeActiveStore();
    runEventProcessor = new RuntimeEventProcessor(
      mockRunRecordService as RunRecordService,
      runRegistry,
      mockConversationService as ConversationService,
      mockAgentEventLogService as AgentEventLogService,
      mockRunEventRecordService as RunEventRecordService
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
    expect(mockRunRecordService.markRunning).toHaveBeenCalledTimes(1);
    expect(mockRunEventRecordService.record).toHaveBeenCalledTimes(1);
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
    expect(mockRunRecordService.updateHeartbeat).toHaveBeenCalledWith("run-1");
    expect(mockRunEventRecordService.record).not.toHaveBeenCalled();
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

    expect(mockRunRecordService.markError).toHaveBeenCalledWith(
      "run-1",
      "worker heartbeat timeout"
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
      aggregator: new RuntimeMessageAggregator(),
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
    expect(mockAgentEventLogService.writeAgui).toHaveBeenCalledWith(
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
      aggregator: new RuntimeMessageAggregator(),
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
      aggregator: new RuntimeMessageAggregator(),
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

    expect(mockAgentEventLogService.writeRaw).toHaveBeenCalledWith(
      traceConfig,
      payload
    );
    expect(aggregator.handle).not.toHaveBeenCalled();
  });
});
