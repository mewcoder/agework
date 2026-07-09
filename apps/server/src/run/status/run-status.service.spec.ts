import { describe, expect, it, vi } from "vitest";
import {
  LiveRunRegistry,
  type LiveRunHandle,
} from "../live-run/live-run.registry";
import type { ConversationService } from "../../conversation/conversation.service";
import { runStatusEffect } from "./run-status.policy";
import { RunRepository } from "../run.repository";
import { RunStatusService } from "./run-status.service";
import { RunFinalizationStore } from "./run-finalization.store";
import { WorkerSeqStore } from "../upstream/worker-seq.store";
import type { WorkerAgUiEventHandler } from "../upstream/worker-agui-event.handler";
import type { RunEventService } from "../../run-event/run-event.service";
import type { ConfigService } from "../../config/config.service";
import { RunStream } from "../streaming/run-stream";

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

function makeHandle(overrides: Partial<LiveRunHandle> = {}): LiveRunHandle {
  return {
    runtimeHandle: {
      runId: "run-1",
      runtimeType: "native",
      runtimeInstanceId: "1:token",
      conversationId: "conversation-1",
    },
    stream: new RunStream(makeRes()),
    aggregator: {
      build: vi.fn().mockReturnValue({ messageId: undefined }),
    } as never,
    conversationId: "conversation-1",
    runId: "run-1",
    workspaceId: "ws-1",
    agentType: "claude",
    stopRequested: false,
    saveRun: vi.fn(),
    ...overrides,
  };
}

function makeSubject(input?: {
  activeRun?: { id: string } | null;
  registry?: LiveRunRegistry;
}) {
  const runRepository = {
    markRunning: vi.fn().mockResolvedValue(undefined),
    markRequiresAction: vi.fn().mockResolvedValue(undefined),
    markFinished: vi.fn().mockResolvedValue(undefined),
    markError: vi.fn().mockResolvedValue(undefined),
    markCancelled: vi.fn().mockResolvedValue(undefined),
    markCancelling: vi.fn().mockResolvedValue(undefined),
    findActiveByConversationId: vi
      .fn()
      .mockResolvedValue(input?.activeRun ?? null),
  };
  const runConversation = {
    setConversationRunState: vi.fn().mockResolvedValue(undefined),
  } satisfies Partial<ConversationService>;
  const registry = input?.registry ?? new LiveRunRegistry(makeConfig());
  const finalization = new RunFinalizationStore();
  const seqGate = new WorkerSeqStore();
  const aguiEvents = { clearRun: vi.fn() };
  const runEvents = {
    append: vi.fn().mockResolvedValue(undefined),
    fromRunStatusPayload: vi
      .fn()
      .mockReturnValue({ runId: "run-1", type: "run.status_changed" }),
    runStatusChanged: vi.fn((eventInput: Record<string, unknown>) => ({
      runId: eventInput.runId,
      type: "run.status_changed",
      data: eventInput,
    })),
    permissionRequested: vi.fn((eventInput: Record<string, unknown>) => ({
      runId: eventInput.runId,
      type: "permission.requested",
    })),
    messageFailed: vi.fn((eventInput: { messageId?: string }) =>
      eventInput.messageId
        ? { runId: "run-1", type: "message.failed" }
        : undefined
    ),
    forgetRun: vi.fn(),
  };
  return {
    runRepository,
    runConversation,
    registry,
    finalization,
    seqGate,
    aguiEvents,
    runEvents,
    handler: new RunStatusService(
      runRepository as unknown as RunRepository,
      runConversation as unknown as ConversationService,
      registry,
      finalization,
      seqGate,
      aguiEvents as unknown as WorkerAgUiEventHandler,
      runEvents as unknown as RunEventService
    ),
  };
}

describe("RunStatusService", () => {
  it("persists requires_action and saves a partial message snapshot", async () => {
    const { handler, runRepository, runConversation, registry } = makeSubject();
    const handle = makeHandle();
    registry.register("run-1", handle);

    await handler.apply({
      runId: "run-1",
      payload: { status: "requires_action", pendingAction: "question" },
      effect: runStatusEffect("requires_action"),
    });

    expect(runRepository.markRequiresAction).toHaveBeenCalledWith("run-1");
    expect(handle.saveRun).toHaveBeenCalledWith(false);
    expect(runConversation.setConversationRunState).toHaveBeenCalledWith(
      "conversation-1",
      { pendingUserAction: "question" }
    );
  });

  it("records permission.requested when entering requires_action", async () => {
    const { handler, registry, runEvents } = makeSubject();
    const handle = makeHandle();
    registry.register("run-1", handle);

    await handler.apply({
      runId: "run-1",
      payload: { status: "requires_action", pendingAction: "question" },
      effect: runStatusEffect("requires_action"),
    });

    expect(runEvents.permissionRequested).toHaveBeenCalledWith({
      runId: "run-1",
    });
  });

  it("applies error terminal effects and closes the SSE response", async () => {
    const registry = new LiveRunRegistry(makeConfig());
    const unregister = vi.spyOn(registry, "unregister");
    const { handler, runRepository, runConversation, runEvents } = makeSubject({
      activeRun: { id: "run-1" },
      registry,
    });
    const res = makeRes();
    const handle = makeHandle({
      stream: new RunStream(res),
      aggregator: {
        build: vi.fn().mockReturnValue({ messageId: "msg-1" }),
      } as never,
    });
    registry.register("run-1", handle);

    await handler.apply({
      runId: "run-1",
      payload: { status: "error", error: "boom" },
      effect: runStatusEffect("error"),
    });

    expect(runRepository.markError).toHaveBeenCalledWith("run-1", "boom");
    expect(runConversation.setConversationRunState).toHaveBeenCalledWith(
      "conversation-1",
      { runStatus: "error" }
    );
    expect(handle.saveRun).toHaveBeenCalledWith(false, "error");
    expect(res.write).toHaveBeenCalledWith(
      expect.stringContaining('"type":"RUN_ERROR"')
    );
    expect(res.end).toHaveBeenCalled();
    expect(unregister).toHaveBeenCalledWith("run-1");
    expect(runEvents.messageFailed).toHaveBeenCalledWith({
      runId: "run-1",
      messageId: "msg-1",
      reason: "error",
    });
  });

  it("does not overwrite conversation status when a newer run is active", async () => {
    const { handler, runConversation, registry } = makeSubject({
      activeRun: { id: "run-2" },
    });
    const handle = makeHandle();
    registry.register("run-1", handle);

    await handler.apply({
      runId: "run-1",
      payload: { status: "finished" },
      effect: runStatusEffect("finished"),
    });

    expect(runConversation.setConversationRunState).not.toHaveBeenCalled();
    expect(handle.saveRun).toHaveBeenCalledWith(true, undefined);
  });

  it("unregisters terminal runs even when final message saving fails", async () => {
    const registry = new LiveRunRegistry(makeConfig());
    const unregister = vi.spyOn(registry, "unregister");
    const { handler } = makeSubject({ registry });
    const handle = makeHandle({
      saveRun: vi.fn(() => {
        throw new Error("save failed");
      }),
    });
    registry.register("run-1", handle);

    await expect(
      handler.apply({
        runId: "run-1",
        payload: { status: "finished" },
        effect: runStatusEffect("finished"),
      })
    ).rejects.toThrow("save failed");

    expect(unregister).toHaveBeenCalledWith("run-1");
  });

  it("forgets all per-run in-memory state after a terminal apply", async () => {
    const { handler, seqGate, aguiEvents, runEvents, registry } = makeSubject({
      activeRun: { id: "run-1" },
    });
    registry.register("run-1", makeHandle());
    seqGate.accept("run-1", 1);

    await handler.apply({
      runId: "run-1",
      payload: { status: "finished" },
      effect: runStatusEffect("finished"),
    });

    // seq 游标已被遗忘:同一 seq 再来不会被判重复
    expect(seqGate.accept("run-1", 1).action).toBe("accept");
    expect(aguiEvents.clearRun).toHaveBeenCalledWith("run-1");
    expect(runEvents.forgetRun).toHaveBeenCalledWith("run-1");
  });

  it("decides ignore for statuses arriving after a terminal apply", async () => {
    const { handler, registry } = makeSubject({ activeRun: { id: "run-1" } });
    registry.register("run-1", makeHandle());

    expect(handler.decide("run-1", { status: "finished" }).action).toBe(
      "apply"
    );

    await handler.apply({
      runId: "run-1",
      payload: { status: "finished" },
      effect: runStatusEffect("finished"),
    });

    expect(handler.decide("run-1", { status: "error" }).action).toBe("ignore");
    expect(handler.isTerminalOrFinalizing("run-1")).toBe(true);
  });

  it("marks cancelling and records a platform status event on cancel request", async () => {
    const { handler, runRepository, runEvents } = makeSubject();

    await handler.markCancelRequested("run-1", "user_steered");

    expect(runRepository.markCancelling).toHaveBeenCalledWith("run-1");
    expect(runEvents.runStatusChanged).toHaveBeenCalledWith({
      runId: "run-1",
      origin: "platform",
      status: "cancelling",
      reason: "user_steered",
    });
    expect(runEvents.append).toHaveBeenCalled();
  });

  it("marks cancelled and records a platform status event when no handle exists", async () => {
    const { handler, runRepository, runEvents } = makeSubject();

    await handler.markCancelledWithoutHandle("run-1");

    expect(runRepository.markCancelled).toHaveBeenCalledWith("run-1");
    expect(runEvents.runStatusChanged).toHaveBeenCalledWith({
      runId: "run-1",
      origin: "platform",
      status: "cancelled",
      reason: "cancelled_without_handle",
    });
  });
});
