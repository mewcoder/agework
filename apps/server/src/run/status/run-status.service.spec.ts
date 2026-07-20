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
import { UpstreamSeqStore } from "../upstream/upstream-seq.store";
import type { HostAgUiEventHandler } from "../upstream/host-agui-event.handler";
import type { RunEventService } from "../../run-event/run-event.service";
import type { ConfigService } from "../../config/config.service";
import { RunStream } from "../streaming/run.stream";

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
      runtimeHostId: "builtin",
      runtimeType: "native",
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
    saveRun: vi.fn().mockResolvedValue(undefined),
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
  };
  const runConversation = {
    setConversationRunStateForRun: vi
      .fn()
      .mockResolvedValue(input?.activeRun?.id !== "run-2"),
    reconcileConversationRunState: vi.fn().mockResolvedValue(true),
  } satisfies Partial<ConversationService>;
  const registry = input?.registry ?? new LiveRunRegistry(makeConfig());
  const finalization = new RunFinalizationStore();
  const seqGate = new UpstreamSeqStore();
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
      aguiEvents as unknown as HostAgUiEventHandler,
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
    expect(runConversation.setConversationRunStateForRun).toHaveBeenCalledWith(
      "conversation-1",
      "run-1",
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
    expect(runConversation.setConversationRunStateForRun).toHaveBeenCalledWith(
      "conversation-1",
      "run-1",
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

  it("settles through the activeRunId CAS when a newer run owns the projection", async () => {
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

    expect(runConversation.setConversationRunStateForRun).toHaveBeenCalledWith(
      "conversation-1",
      "run-1",
      { runStatus: "idle" }
    );
    expect(handle.saveRun).toHaveBeenCalledWith(true, undefined);
  });

  it("keeps terminal runs registered when final message saving fails", async () => {
    const registry = new LiveRunRegistry(makeConfig());
    const unregister = vi.spyOn(registry, "unregister");
    const { handler } = makeSubject({ registry });
    const handle = makeHandle({
      saveRun: vi.fn().mockRejectedValue(new Error("save failed")),
    });
    registry.register("run-1", handle);

    await expect(
      handler.apply({
        runId: "run-1",
        payload: { status: "finished" },
        effect: runStatusEffect("finished"),
      })
    ).rejects.toThrow("save failed");

    expect(unregister).not.toHaveBeenCalled();
    expect(registry.get("run-1")).toBe(handle);
    expect(handler.isTerminalOrFinalizing("run-1")).toBe(false);
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

  it("fails a run without a live handle through the single status owner", async () => {
    const { handler, runRepository, runConversation, runEvents } =
      makeSubject();

    await handler.failRun({
      runId: "run-1",
      conversationId: "conversation-1",
      error: "host offline",
    });

    expect(runRepository.markError).toHaveBeenCalledWith(
      "run-1",
      "host offline"
    );
    expect(runConversation.setConversationRunStateForRun).toHaveBeenCalledWith(
      "conversation-1",
      "run-1",
      { runStatus: "error" }
    );
    expect(runEvents.runStatusChanged).toHaveBeenCalledWith({
      runId: "run-1",
      origin: "platform",
      status: "error",
      reason: "host offline",
    });
  });

  it("fails a live run with the normal terminal side effects", async () => {
    const registry = new LiveRunRegistry(makeConfig());
    const unregister = vi.spyOn(registry, "unregister");
    const { handler } = makeSubject({
      activeRun: { id: "run-1" },
      registry,
    });
    const handle = makeHandle();
    registry.register("run-1", handle);

    await handler.failRun({
      runId: "run-1",
      conversationId: "conversation-1",
      error: "host offline",
    });

    expect(handle.saveRun).toHaveBeenCalledWith(false, "error");
    expect(unregister).toHaveBeenCalledWith("run-1");
  });

  it("releases a failed launch claim when no run row became active", async () => {
    const { handler, runConversation } = makeSubject();

    await expect(
      handler.failLaunchClaim({
        runId: "run-1",
        conversationId: "conversation-1",
      })
    ).resolves.toBe(true);

    expect(runConversation.setConversationRunStateForRun).toHaveBeenCalledWith(
      "conversation-1",
      "run-1",
      { runStatus: "error" }
    );
  });

  it("does not release a launch claim after another run became active", async () => {
    const { handler } = makeSubject({
      activeRun: { id: "run-2" },
    });

    await expect(
      handler.failLaunchClaim({
        runId: "run-1",
        conversationId: "conversation-1",
      })
    ).resolves.toBe(false);
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
    const { handler, runRepository, runConversation, runEvents } =
      makeSubject();

    await handler.markCancelledWithoutHandle({
      runId: "run-1",
      conversationId: "conversation-1",
    });

    expect(runRepository.markCancelled).toHaveBeenCalledWith("run-1");
    expect(runConversation.setConversationRunStateForRun).toHaveBeenCalledWith(
      "conversation-1",
      "run-1",
      { runStatus: "idle" }
    );
    expect(runEvents.runStatusChanged).toHaveBeenCalledWith({
      runId: "run-1",
      origin: "platform",
      status: "cancelled",
      reason: "cancelled_without_handle",
    });
  });
});
