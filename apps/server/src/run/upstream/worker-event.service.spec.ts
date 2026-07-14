import { describe, it, expect, vi, beforeEach } from "vitest";
import { WorkerEventService } from "./worker-event.service";
import { RunRepository } from "../run.repository";
import { LiveRunRegistry } from "../live-run/live-run.registry";
import type { ConversationService } from "../../conversation/conversation.service";
import { AssistantMessageAggregator } from "./assistant-message.aggregator";
import { RunEventService } from "../../run-event/run-event.service";
import { RunStatusService } from "../status/run-status.service";
import { RunFinalizationStore } from "../status/run-finalization.store";
import { WorkerSeqStore } from "./worker-seq.store";
import type { ConfigService } from "../../config/config.service";
import type { RuntimeHostContract } from "@agework/shared/protocol";
import { RunStream } from "../streaming/run-stream";
import { WorkerAgUiEventHandler } from "./worker-agui-event.handler";

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

function makeStream(res = makeRes(), mode: "events" | "snapshots" = "events") {
  return new RunStream(res, mode);
}

describe("WorkerEventService", () => {
  let workerEventsService: WorkerEventService;
  let liveRuns: LiveRunRegistry;
  let mockRunRepository: Partial<RunRepository>;
  let mockConversations: Partial<ConversationService>;
  let mockRunEvents: RunEventService;
  let mockRuntimeHost: Partial<RuntimeHostContract>;
  let runStatusService: RunStatusService;
  let seqGate: WorkerSeqStore;

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

    mockConversations = {
      setConversationRunState: vi.fn().mockResolvedValue(undefined),
      setAgentSessionId: vi.fn().mockResolvedValue(undefined),
      activateConversation: vi.fn().mockResolvedValue(true),
    };
    mockRunEvents = new RunEventService({} as never, {} as never, {} as never);
    vi.spyOn(mockRunEvents, "append").mockResolvedValue({} as never);
    vi.spyOn(mockRunEvents, "forgetRun").mockImplementation(() => undefined);
    mockRuntimeHost = {
      releaseRun: vi.fn(),
      setUpstream: vi.fn(),
    };

    liveRuns = new LiveRunRegistry(makeConfig());
    const aguiEvents = new WorkerAgUiEventHandler(
      mockRunRepository as RunRepository,
      liveRuns,
      mockRunEvents
    );
    seqGate = new WorkerSeqStore();
    runStatusService = new RunStatusService(
      mockRunRepository as RunRepository,
      mockConversations as unknown as ConversationService,
      liveRuns,
      new RunFinalizationStore(),
      seqGate,
      aguiEvents,
      mockRunEvents
    );
    workerEventsService = new WorkerEventService(
      liveRuns,
      mockRunEvents,
      runStatusService,
      aguiEvents,
      seqGate,
      mockRunRepository as RunRepository,
      mockRuntimeHost as RuntimeHostContract
    );
  });

  it("should be defined", () => {
    expect(workerEventsService).toBeDefined();
  });

  it("emit delegates to publish", async () => {
    const publish = vi
      .spyOn(workerEventsService, "publish")
      .mockResolvedValue(undefined);
    const message = {
      runId: "run-1",
      seq: 1,
      type: "agui.event" as const,
      payload: {},
      ts: new Date().toISOString(),
    };

    await workerEventsService.emit("run-1", message);

    expect(publish).toHaveBeenCalledWith(message);
  });

  it("emit releases the run on terminal run status", async () => {
    const runtimeHandle = {
      runId: "run-1",
      runtimeHostId: "builtin",
      runtimeType: "native",
      conversationId: "conversation-1",
    };
    liveRuns.register("run-1", {
      runtimeHandle,
      runId: "run-1",
      conversationId: "conversation-1",
      workspaceId: "ws-1",
      agentType: "claude",
      stream: makeStream(),
      aggregator: { handle: vi.fn() } as any,
      stopRequested: false,
      saveRun: vi.fn(),
    });

    await workerEventsService.emit("run-1", {
      runId: "run-1",
      seq: 1,
      type: "run.status",
      payload: { status: "finished" },
      ts: new Date().toISOString(),
    });

    expect(mockRuntimeHost.releaseRun).toHaveBeenCalledWith(runtimeHandle);
  });

  it("notifyRunFailed skips when run already terminal/finalizing", async () => {
    vi.spyOn(workerEventsService, "isTerminalOrFinalizing").mockReturnValue(
      true
    );
    const forceErrorStatus = vi.spyOn(workerEventsService, "forceErrorStatus");

    await workerEventsService.notifyRunFailed("run-1", "crashed");

    expect(forceErrorStatus).not.toHaveBeenCalled();
  });

  it("notifyRunFailed forces error status when run not terminal", async () => {
    vi.spyOn(workerEventsService, "isTerminalOrFinalizing").mockReturnValue(
      false
    );
    const forceErrorStatus = vi
      .spyOn(workerEventsService, "forceErrorStatus")
      .mockResolvedValue(undefined);

    await workerEventsService.notifyRunFailed("run-1", "crashed");

    expect(forceErrorStatus).toHaveBeenCalledWith("run-1", "crashed");
  });

  it("notifyWorkerLost delegates to notifyRunFailed (fence terminates via the same terminal-status path)", async () => {
    const notifyRunFailed = vi
      .spyOn(workerEventsService, "notifyRunFailed")
      .mockResolvedValue(undefined);

    await workerEventsService.notifyWorkerLost(
      "run-1",
      "worker heartbeat timeout"
    );

    expect(notifyRunFailed).toHaveBeenCalledWith(
      "run-1",
      "worker heartbeat timeout"
    );
    expect(mockRunEvents.append).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "worker.status_changed",
        data: expect.objectContaining({
          status: "lost",
          reason: "worker heartbeat timeout",
        }),
      })
    );
  });

  it("notifyRunCancelled forces cancelled when run not terminal", async () => {
    vi.spyOn(workerEventsService, "isTerminalOrFinalizing").mockReturnValue(
      false
    );
    const forceCancelledStatus = vi
      .spyOn(workerEventsService, "forceCancelledStatus")
      .mockResolvedValue(undefined);

    await workerEventsService.notifyRunCancelled("run-1");

    expect(forceCancelledStatus).toHaveBeenCalledWith("run-1");
  });

  it("should deduplicate messages by seq", async () => {
    const message = {
      runId: "run-1",
      seq: 1,
      type: "run.status" as const,
      payload: { status: "running" as const },
      ts: new Date().toISOString(),
    };

    // First publish
    await workerEventsService.publish(message);
    // Second with same seq should be dropped
    await workerEventsService.publish(message);

    // markRunning should only be called once
    expect(mockRunRepository.markRunning).toHaveBeenCalledTimes(1);
    expect(mockRunEvents.append).toHaveBeenCalledTimes(1);
    expect(mockRunEvents.append).toHaveBeenCalledWith(
      expect.objectContaining({ type: "run.status_changed" })
    );
  });

  it("records command result events", async () => {
    await workerEventsService.publish({
      runId: "run-1",
      seq: 1,
      type: "command.result",
      payload: {
        commandId: "cmd-1",
        commandType: "cancel",
        status: "ok",
      },
      ts: new Date().toISOString(),
    });

    expect(mockRunEvents.append).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "command.result",
        targetId: "cmd-1",
        data: expect.objectContaining({
          commandType: "cancel",
          status: "ok",
        }),
      })
    );
  });

  it("forceErrorStatus marks the run as error and bypasses seq dedup", async () => {
    await workerEventsService.publish({
      runId: "run-1",
      seq: 5,
      type: "run.status" as const,
      payload: { status: "running" as const },
      ts: new Date().toISOString(),
    });

    await workerEventsService.forceErrorStatus("run-1", "run timeout");

    expect(mockRunRepository.markError).toHaveBeenCalledWith(
      "run-1",
      "run timeout"
    );
  });

  it("markRunTimedOut marks error and releases the run", async () => {
    const runtimeHandle = {
      runId: "run-1",
      runtimeHostId: "builtin",
      runtimeType: "native",
      conversationId: "conversation-1",
    };

    await workerEventsService.markRunTimedOut("run-1", runtimeHandle);

    expect(mockRunRepository.markError).toHaveBeenCalledWith(
      "run-1",
      "run timeout"
    );
    expect(mockRuntimeHost.releaseRun).toHaveBeenCalledWith(runtimeHandle);
  });

  it("still applies terminal status when run event recording fails", async () => {
    mockRunEvents.append = vi.fn().mockRejectedValue(new Error("SQLITE_BUSY"));

    await expect(
      workerEventsService.publish({
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
    await workerEventsService.publish({
      runId: "run-1",
      seq: 1,
      type: "run.status" as const,
      payload: { status: "finished" as const },
      ts: new Date().toISOString(),
    });

    expect(mockRunRepository.markFinished).toHaveBeenCalledWith("run-1");

    (mockRunRepository.markRunning as ReturnType<typeof vi.fn>).mockClear();
    (mockRunEvents.append as ReturnType<typeof vi.fn>).mockClear();

    await workerEventsService.publish({
      runId: "run-1",
      seq: 2,
      type: "run.status" as const,
      payload: { status: "running" as const },
      ts: new Date().toISOString(),
    });

    expect(mockRunRepository.markRunning).not.toHaveBeenCalled();
    expect(mockRunEvents.append).not.toHaveBeenCalled();
  });

  it("ignores late run.status after terminal before any seq accounting", async () => {
    await workerEventsService.publish({
      runId: "run-1",
      seq: 1,
      type: "run.status" as const,
      payload: { status: "finished" as const },
      ts: new Date().toISOString(),
    });
    const acceptSpy = vi.spyOn(seqGate, "accept");

    await workerEventsService.publish({
      runId: "run-1",
      seq: 2,
      type: "run.status" as const,
      payload: { status: "running" as const },
      ts: new Date().toISOString(),
    });

    // 终态清理已 forget 该 run 的 seq 游标,迟到的状态消息必须在 seq 记账之前
    // 被拦下,否则会把已清空的 per-run seq 状态重建出来。
    expect(acceptSpy).not.toHaveBeenCalled();
  });

  it("records a seq gap as a system.issue event but still processes the message", async () => {
    await workerEventsService.publish({
      runId: "run-1",
      seq: 5,
      type: "run.status" as const,
      payload: { status: "running" as const },
      ts: new Date().toISOString(),
    });

    expect(mockRunEvents.append).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "system.issue",
        data: expect.objectContaining({ expected: 1, got: 5 }),
      })
    );
    expect(mockRunRepository.markRunning).toHaveBeenCalledWith("run-1");
  });

  it("keeps the terminal guard when status application fails mid-finalization", async () => {
    liveRuns.register("run-1", {
      runtimeHandle: {
        runId: "run-1",
        runtimeHostId: "builtin",
        runtimeType: "native",
        conversationId: "conversation-1",
      },
      runId: "run-1",
      conversationId: "conversation-1",
      workspaceId: "ws-1",
      agentType: "claude",
      stream: makeStream(),
      aggregator: { handle: vi.fn(), build: vi.fn() } as any,
      stopRequested: false,
      saveRun: vi.fn(() => {
        throw new Error("save failed");
      }),
    });

    await expect(
      workerEventsService.publish({
        runId: "run-1",
        seq: 1,
        type: "run.status" as const,
        payload: { status: "finished" as const },
        ts: new Date().toISOString(),
      })
    ).rejects.toThrow("save failed");

    // markCompleted 必须先于可能抛异常的收尾动作:守卫已生效,内存态已清理,
    // 后续 force 不再重复终态
    expect(workerEventsService.isTerminalOrFinalizing("run-1")).toBe(true);
    expect(mockRunEvents.forgetRun).toHaveBeenCalledWith("run-1");

    await workerEventsService.notifyRunFailed("run-1", "late crash");
    expect(mockRunRepository.markError).not.toHaveBeenCalled();
  });

  it("continues AG-UI processing when run event recording fails", async () => {
    mockRunEvents.append = vi.fn().mockRejectedValue(new Error("SQLITE_BUSY"));
    const aggregator = { handle: vi.fn() };
    liveRuns.register("run-1", {
      runtimeHandle: {
        runId: "run-1",
        runtimeHostId: "builtin",
        runtimeType: "native",
        conversationId: "conversation-1",
      },
      runId: "run-1",
      conversationId: "conversation-1",
      workspaceId: "ws-1",
      agentType: "claude",
      stream: makeStream(),
      aggregator: aggregator as any,
      stopRequested: false,
      saveRun: vi.fn(),
    });

    await expect(
      workerEventsService.publish({
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

    expect(aggregator.handle).toHaveBeenCalledWith(
      expect.objectContaining({ type: "TOOL_CALL_START" })
    );
  });

  it("persists agent.sessionId only through the live run callback", async () => {
    const onAgentSessionId = vi.fn((sessionId: string) => {
      void mockConversations.setAgentSessionId?.("conversation-1", sessionId);
    });
    liveRuns.register("run-1", {
      runtimeHandle: {
        runId: "run-1",
        runtimeHostId: "builtin",
        runtimeType: "native",
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
      onAgentSessionId,
    });

    await workerEventsService.publish({
      runId: "run-1",
      seq: 1,
      type: "agui.event" as const,
      payload: {
        type: "CUSTOM",
        name: "agent.sessionId",
        value: "session-1",
      },
      ts: new Date().toISOString(),
    });

    expect(onAgentSessionId).toHaveBeenCalledTimes(1);
    expect(onAgentSessionId).toHaveBeenCalledWith("session-1");
    expect(mockConversations.setAgentSessionId).toHaveBeenCalledTimes(1);
    expect(mockConversations.setAgentSessionId).toHaveBeenCalledWith(
      "conversation-1",
      "session-1"
    );
  });

  it("persists system:init session_id only through the live run callback", async () => {
    const onAgentSessionId = vi.fn((sessionId: string) => {
      void mockConversations.setAgentSessionId?.("conversation-1", sessionId);
    });
    liveRuns.register("run-1", {
      runtimeHandle: {
        runId: "run-1",
        runtimeHostId: "builtin",
        runtimeType: "native",
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
      onAgentSessionId,
    });

    await workerEventsService.publish({
      runId: "run-1",
      seq: 1,
      type: "agui.event" as const,
      payload: {
        type: "CUSTOM",
        name: "system:init",
        value: { session_id: "session-1" },
      },
      ts: new Date().toISOString(),
    });

    expect(onAgentSessionId).toHaveBeenCalledTimes(1);
    expect(onAgentSessionId).toHaveBeenCalledWith("session-1");
    expect(mockConversations.setAgentSessionId).toHaveBeenCalledTimes(1);
    expect(mockConversations.setAgentSessionId).toHaveBeenCalledWith(
      "conversation-1",
      "session-1"
    );
  });

  it("processes AG-UI events when the worker owns runtime trace files", async () => {
    const aggregator = { handle: vi.fn() };
    liveRuns.register("run-1", {
      runtimeHandle: {
        runId: "run-1",
        runtimeHostId: "builtin",
        runtimeType: "native",
        conversationId: "conversation-1",
      },
      runId: "run-1",
      conversationId: "conversation-1",
      workspaceId: "ws-1",
      agentType: "claude",
      stream: makeStream(),
      aggregator: aggregator as any,
      stopRequested: false,
      saveRun: vi.fn(),
    });

    await workerEventsService.publish({
      runId: "run-1",
      seq: 1,
      type: "agui.event",
      payload: { type: "RUN_STARTED" },
      ts: new Date().toISOString(),
    });

    expect(aggregator.handle).toHaveBeenCalledWith({ type: "RUN_STARTED" });
  });

  it("should not forward MESSAGES_SNAPSHOT events to the SSE response", async () => {
    const res = makeRes();
    liveRuns.register("run-1", {
      runtimeHandle: {
        runId: "run-1",
        runtimeHostId: "builtin",
        runtimeType: "native",
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

    await workerEventsService.publish({
      runId: "run-1",
      seq: 1,
      type: "agui.event" as const,
      payload: { type: "MESSAGES_SNAPSHOT", messages: [] },
      ts: new Date().toISOString(),
    });

    expect(res.write).not.toHaveBeenCalled();
  });

  it("snapshot stream 推送累积快照而非原始事件", async () => {
    const res = makeRes();
    liveRuns.register("run-1", {
      runtimeHandle: {
        runId: "run-1",
        runtimeHostId: "builtin",
        runtimeType: "native",
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
    await workerEventsService.publish({
      runId: "run-1",
      seq: 1,
      type: "agui.event",
      payload: { type: "RUN_STARTED", runId: "run-1" },
      ts: "",
    });
    await workerEventsService.publish({
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
    await workerEventsService.publish({
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
    await workerEventsService.publish({
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
    liveRuns.register("run-2", {
      runtimeHandle: {
        runId: "run-2",
        runtimeHostId: "builtin",
        runtimeType: "native",
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

    await workerEventsService.publish({
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
    liveRuns.register("run-1", {
      runtimeHandle: {
        runId: "run-1",
        runtimeHostId: "builtin",
        runtimeType: "native",
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

    await workerEventsService.publish({
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
    liveRuns.register("run-1", {
      runtimeHandle: {
        runId: "run-1",
        runtimeHostId: "builtin",
        runtimeType: "native",
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

    await workerEventsService.publish({
      runId: "run-1",
      seq: 1,
      type: "agui.event" as const,
      payload: {
        type: "RUN_FINISHED",
        result: {
          usage: {
            inputTokens: 1000,
            outputTokens: 500,
            cachedInputTokens: 200,
            reasoningOutputTokens: 80,
            cacheCreationInputTokens: 0,
            totalCostUsd: null,
            numTurns: 3,
            durationApiMs: null,
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
    liveRuns.register("run-1", {
      runtimeHandle: {
        runId: "run-1",
        runtimeHostId: "builtin",
        runtimeType: "native",
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

    await workerEventsService.publish({
      runId: "run-1",
      seq: 1,
      type: "agui.event" as const,
      payload: {
        type: "RUN_FINISHED",
        result: { usage: { inputTokens: "oops", outputTokens: null } },
      },
      ts: new Date().toISOString(),
    });

    expect(mockRunRepository.recordUsage).not.toHaveBeenCalled();
  });

  it("records raw SDK error events without forwarding them to the aggregator", async () => {
    const aggregator = { handle: vi.fn() };
    liveRuns.register("run-1", {
      runtimeHandle: {
        runId: "run-1",
        runtimeHostId: "builtin",
        runtimeType: "native",
        conversationId: "conversation-1",
      },
      runId: "run-1",
      conversationId: "conversation-1",
      workspaceId: "ws-1",
      agentType: "claude",
      stream: makeStream(),
      aggregator: aggregator as any,
      stopRequested: false,
      saveRun: vi.fn(),
    });

    const payload = {
      name: "sdk.claude.error",
      threadId: "conversation-1",
      payload: { value: "boom" },
    };
    await workerEventsService.publish({
      runId: "run-1",
      seq: 1,
      type: "sdk.raw" as const,
      payload,
      ts: new Date().toISOString(),
    });

    expect(mockRunEvents.append).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "system.issue",
        origin: "agent",
        data: expect.objectContaining({
          providerEventName: "sdk.claude.error",
          threadId: "conversation-1",
        }),
      })
    );
    expect(aggregator.handle).not.toHaveBeenCalled();
  });
});
