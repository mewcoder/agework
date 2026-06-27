import { describe, it, expect, vi, beforeEach } from "vitest";
import { RunEnvelopeProcessor } from "./run-envelope.processor";
import { RunRepository } from "../run.repository";
import { ActiveRunRegistry } from "../lifecycle/active-run.registry";
import { ConversationService } from "../../conversations/conversation.service";
import { AssistantMessageAggregator } from "../assistant-message.aggregator";
import { AgentEventTraceWriter } from "../events/agent-event-trace.writer";
import { RunEventService } from "../events/run-event.service";
import { RunStatusService } from "../lifecycle/run-status.service";
import type { ConfigService } from "../../config/config.service";
import type { RunDriver } from "./run-driver";
import { RunStream } from "../lifecycle/run-stream";

function makeConfig(): ConfigService {
  return {
    getRunTimeoutSeconds: () => 60,
  } as ConfigService;
}

function makeRes() {
  return {
    setHeader: vi.fn(),
    write: vi.fn(),
    end: vi.fn(),
    writableEnded: false,
    on: vi.fn(),
    status: vi.fn(),
  } as any;
}

function makeStream(
  res = makeRes(),
  mode: "events" | "snapshots" = "events"
) {
  return new RunStream(res, mode);
}

describe("RunEnvelopeProcessor", () => {
  let runEnvelopeProcessor: RunEnvelopeProcessor;
  let activeRuns: ActiveRunRegistry;
  let mockRunRepository: Partial<RunRepository>;
  let mockConversationService: Partial<ConversationService>;
  let mockEventTraceWriter: Partial<AgentEventTraceWriter>;
  let mockRunEvents: RunEventService;
  let mockRunDriver: Partial<RunDriver>;

  beforeEach(() => {
    mockRunRepository = {
      markRunning: vi.fn().mockResolvedValue(undefined),
      markFinished: vi.fn().mockResolvedValue(undefined),
      markError: vi.fn().mockResolvedValue(undefined),
      markCancelled: vi.fn().mockResolvedValue(undefined),
      markRequiresAction: vi.fn().mockResolvedValue(undefined),
      findActiveByConversationId: vi.fn().mockResolvedValue(null),
      recordUsage: vi.fn().mockResolvedValue(undefined),
    };

    mockConversationService = {
      setPendingUserAction: vi.fn().mockResolvedValue(undefined),
      setActiveRunStatus: vi.fn().mockResolvedValue(undefined),
    };
    mockEventTraceWriter = {
      writeRaw: vi.fn(),
      writeAgui: vi.fn(),
    };
    mockRunEvents = new RunEventService({} as never);
    vi.spyOn(mockRunEvents, "append").mockResolvedValue({} as never);
    vi.spyOn(mockRunEvents, "forgetRun").mockImplementation(() => undefined);
    mockRunDriver = {
      terminateExecution: vi.fn(),
    };

    activeRuns = new ActiveRunRegistry(makeConfig());
    const runStatusService = new RunStatusService(
      mockRunRepository as RunRepository,
      mockConversationService as ConversationService,
      activeRuns
    );
    runEnvelopeProcessor = new RunEnvelopeProcessor(
      mockRunRepository as RunRepository,
      activeRuns,
      mockConversationService as ConversationService,
      mockEventTraceWriter as AgentEventTraceWriter,
      mockRunEvents,
      runStatusService,
      mockRunDriver as RunDriver
    );
  });

  it("should be defined", () => {
    expect(runEnvelopeProcessor).toBeDefined();
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
    await runEnvelopeProcessor.publish(envelope);
    // Second with same seq should be dropped
    await runEnvelopeProcessor.publish(envelope);

    // markRunning should only be called once
    expect(mockRunRepository.markRunning).toHaveBeenCalledTimes(1);
    expect(mockRunEvents.append).toHaveBeenCalledTimes(1);
    expect(mockRunEvents.append).toHaveBeenCalledWith(
      expect.objectContaining({ type: "run.status_changed" })
    );
  });

  it("forceErrorStatus marks the run as error and bypasses seq dedup", async () => {
    await runEnvelopeProcessor.publish({
      runId: "run-1",
      seq: 5,
      type: "run.status" as const,
      payload: { status: "running" as const },
      ts: new Date().toISOString(),
    });

    await runEnvelopeProcessor.forceErrorStatus("run-1", "run timeout");

    expect(mockRunRepository.markError).toHaveBeenCalledWith(
      "run-1",
      "run timeout"
    );
  });

  it("markRunTimedOut marks error and terminates the execution session", async () => {
    const runtimeHandle = {
      runId: "run-1",
      runtimeType: "local",
      runtimeInstanceId: "1:token",
      conversationId: "conversation-1",
    };

    await runEnvelopeProcessor.markRunTimedOut("run-1", runtimeHandle);

    expect(mockRunRepository.markError).toHaveBeenCalledWith(
      "run-1",
      "run timeout"
    );
    expect(mockRunDriver.terminateExecution).toHaveBeenCalledWith(
      runtimeHandle,
      "run timeout"
    );
  });

  it("still applies terminal status when run event recording fails", async () => {
    mockRunEvents.append = vi
      .fn()
      .mockRejectedValue(new Error("SQLITE_BUSY"));

    await expect(
      runEnvelopeProcessor.publish({
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
    await runEnvelopeProcessor.publish({
      runId: "run-1",
      seq: 1,
      type: "run.status" as const,
      payload: { status: "finished" as const },
      ts: new Date().toISOString(),
    });

    expect(mockRunRepository.markFinished).toHaveBeenCalledWith("run-1");

    (mockRunRepository.markRunning as ReturnType<typeof vi.fn>).mockClear();
    (mockRunEvents.append as ReturnType<typeof vi.fn>).mockClear();

    await runEnvelopeProcessor.publish({
      runId: "run-1",
      seq: 2,
      type: "run.status" as const,
      payload: { status: "running" as const },
      ts: new Date().toISOString(),
    });

    expect(mockRunRepository.markRunning).not.toHaveBeenCalled();
    expect(mockRunEvents.append).not.toHaveBeenCalled();
  });

  it("continues AG-UI processing when run event recording fails", async () => {
    mockRunEvents.append = vi
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
    activeRuns.register("run-1", {
      runtimeHandle: {
        runId: "run-1",
        runtimeType: "local",
        runtimeInstanceId: "1:token",
        conversationId: "conversation-1",
      },
      runId: "run-1",
      conversationId: "conversation-1",
      workspaceId: "ws-1",
      agentType: "claude",
      agentEventTrace: traceConfig,
      stream: makeStream(),
      aggregator: aggregator as any,
      stopRequested: false,
      saveRun: vi.fn(),
    });

    await expect(
      runEnvelopeProcessor.publish({
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

    expect(mockEventTraceWriter.writeAgui).toHaveBeenCalledWith(
      traceConfig,
      expect.objectContaining({ type: "TOOL_CALL_START" })
    );
    expect(aggregator.handle).toHaveBeenCalledWith(
      expect.objectContaining({ type: "TOOL_CALL_START" })
    );
  });

  it("should not forward MESSAGES_SNAPSHOT events to the SSE response", async () => {
    const res = makeRes();
    activeRuns.register("run-1", {
      runtimeHandle: {
        runId: "run-1",
        runtimeType: "local",
        runtimeInstanceId: "1:token",
        conversationId: "conversation-1",
      },
      runId: "run-1",
      conversationId: "conversation-1",
      workspaceId: "ws-1",
      agentType: "claude",
      stream: makeStream(res),
      aggregator: new AssistantMessageAggregator(),
      stopRequested: false,
      saveRun: vi.fn(),
    });

    await runEnvelopeProcessor.publish({
      runId: "run-1",
      seq: 1,
      type: "agui.event" as const,
      payload: { type: "MESSAGES_SNAPSHOT", messages: [] },
      ts: new Date().toISOString(),
    });

    expect(res.write).not.toHaveBeenCalled();
    expect(mockEventTraceWriter.writeAgui).toHaveBeenCalledWith(undefined, {
      type: "MESSAGES_SNAPSHOT",
      messages: [],
    });
  });

  it("snapshot stream 推送累积快照而非原始事件", async () => {
    const res = makeRes();
    activeRuns.register("run-1", {
      runtimeHandle: {
        runId: "run-1",
        runtimeType: "local",
        runtimeInstanceId: "1:token",
        conversationId: "conversation-1",
      },
      runId: "run-1",
      conversationId: "conversation-1",
      workspaceId: "ws-1",
      agentType: "claude",
      stream: makeStream(res, "snapshots"),
      aggregator: new AssistantMessageAggregator(),
      stopRequested: false,
      saveRun: vi.fn(),
    });

    // RUN_STARTED + 文本开始 + 内容 + 结束
    await runEnvelopeProcessor.publish({
      runId: "run-1",
      seq: 1,
      type: "agui.event",
      payload: { type: "RUN_STARTED", runId: "run-1" },
      ts: "",
    });
    await runEnvelopeProcessor.publish({
      runId: "run-1",
      seq: 2,
      type: "agui.event",
      payload: {
        type: "TEXT_MESSAGE_START",
        messageId: "m-1",
        role: "assistant",
      },
      ts: "",
    });
    await runEnvelopeProcessor.publish({
      runId: "run-1",
      seq: 3,
      type: "agui.event",
      payload: {
        type: "TEXT_MESSAGE_CONTENT",
        messageId: "m-1",
        delta: "hello",
      },
      ts: "",
    });
    await runEnvelopeProcessor.publish({
      runId: "run-1",
      seq: 4,
      type: "agui.event",
      payload: { type: "TEXT_MESSAGE_END", messageId: "m-1" },
      ts: "",
    });

    // TEXT_MESSAGE_END 是事件边界，应推送一个含 "hello" 文本的累积快照
    const lastWrite = (res.write as ReturnType<typeof vi.fn>).mock.calls.at(
      -1
    )?.[0] as string;
    expect(lastWrite).toContain("hello");
    expect(lastWrite.startsWith("data:")).toBe(true);
    const parsed = JSON.parse(lastWrite.slice(6).trim());
    expect(parsed.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "text", text: "hello" }),
      ])
    );
  });

  it("event stream 走原始事件转发（回归）", async () => {
    const res = makeRes();
    activeRuns.register("run-2", {
      runtimeHandle: {
        runId: "run-2",
        runtimeType: "local",
        runtimeInstanceId: "2:token",
        conversationId: "conversation-2",
      },
      runId: "run-2",
      conversationId: "conversation-2",
      workspaceId: "ws-1",
      agentType: "claude",
      stream: makeStream(res),
      aggregator: new AssistantMessageAggregator(),
      stopRequested: false,
      saveRun: vi.fn(),
    });

    await runEnvelopeProcessor.publish({
      runId: "run-2",
      seq: 1,
      type: "agui.event",
      payload: { type: "RUN_STARTED", runId: "run-2" },
      ts: "",
    });

    // 原始事件直接 JSON 转发，不是快照形态
    const written = (res.write as ReturnType<typeof vi.fn>).mock.calls.at(
      -1
    )?.[0] as string;
    expect(written).toContain('"type":"RUN_STARTED"');
  });

  it("records failed tool results as tool.failed events", async () => {
    activeRuns.register("run-1", {
      runtimeHandle: {
        runId: "run-1",
        runtimeType: "local",
        runtimeInstanceId: "1:token",
        conversationId: "conversation-1",
      },
      runId: "run-1",
      conversationId: "conversation-1",
      workspaceId: "ws-1",
      agentType: "claude",
      stream: makeStream(),
      aggregator: { handle: vi.fn() } as any,
      stopRequested: false,
      saveRun: vi.fn(),
    });

    await runEnvelopeProcessor.publish({
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

    expect(mockRunEvents.append).toHaveBeenCalledWith(
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
      mockRunEvents.append as ReturnType<typeof vi.fn>
    ).mock.calls.map(([event]) => event.type);
    expect(recordedTypes).not.toContain("tool.completed");
  });

  it("records normalized usage from RUN_FINISHED results", async () => {
    activeRuns.register("run-1", {
      runtimeHandle: {
        runId: "run-1",
        runtimeType: "local",
        runtimeInstanceId: "1:token",
        conversationId: "conversation-1",
      },
      runId: "run-1",
      conversationId: "conversation-1",
      workspaceId: "ws-1",
      agentType: "claude",
      stream: makeStream(),
      aggregator: { handle: vi.fn() } as any,
      stopRequested: false,
      saveRun: vi.fn(),
    });

    await runEnvelopeProcessor.publish({
      runId: "run-1",
      seq: 1,
      type: "agui.event" as const,
      payload: {
        type: "RUN_FINISHED",
        result: {
          numTurns: 3,
          usage: {
            input_tokens: 1000,
            cached_input_tokens: 200,
            output_tokens: 500,
            reasoning_output_tokens: 80,
          },
        },
      },
      ts: new Date().toISOString(),
    });

    expect(mockRunRepository.recordUsage).toHaveBeenCalledWith("run-1", {
      inputTokens: 1000,
      outputTokens: 500,
      cachedInputTokens: 200,
      reasoningOutputTokens: 80,
      cacheCreationInputTokens: 0,
      totalCostUsd: null,
      numTurns: 3,
      durationApiMs: null,
    });
  });

  it("skips usage persistence when RUN_FINISHED has no usable usage fields", async () => {
    activeRuns.register("run-1", {
      runtimeHandle: {
        runId: "run-1",
        runtimeType: "local",
        runtimeInstanceId: "1:token",
        conversationId: "conversation-1",
      },
      runId: "run-1",
      conversationId: "conversation-1",
      workspaceId: "ws-1",
      agentType: "claude",
      stream: makeStream(),
      aggregator: { handle: vi.fn() } as any,
      stopRequested: false,
      saveRun: vi.fn(),
    });

    await runEnvelopeProcessor.publish({
      runId: "run-1",
      seq: 1,
      type: "agui.event" as const,
      payload: {
        type: "RUN_FINISHED",
        result: { usage: { input_tokens: "oops", output_tokens: null } },
      },
      ts: new Date().toISOString(),
    });

    expect(mockRunRepository.recordUsage).not.toHaveBeenCalled();
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
    activeRuns.register("run-1", {
      runtimeHandle: {
        runId: "run-1",
        runtimeType: "local",
        runtimeInstanceId: "1:token",
        conversationId: "conversation-1",
      },
      runId: "run-1",
      conversationId: "conversation-1",
      workspaceId: "ws-1",
      agentType: "claude",
      agentEventTrace: traceConfig,
      stream: makeStream(),
      aggregator: aggregator as any,
      stopRequested: false,
      saveRun: vi.fn(),
    });

    const payload = { name: "sdk.claude.output", payload: { value: "ok" } };
    await runEnvelopeProcessor.publish({
      runId: "run-1",
      seq: 1,
      type: "sdk.raw" as const,
      payload,
      ts: new Date().toISOString(),
    });

    expect(mockEventTraceWriter.writeRaw).toHaveBeenCalledWith(
      traceConfig,
      payload
    );
    expect(aggregator.handle).not.toHaveBeenCalled();
  });
});
