import { describe, expect, it, vi } from "vitest";
import {
  LiveRunRegistry,
  type LiveRunHandle,
} from "../live-run/live-run.registry";
import type { ConversationService } from "../../conversation/conversation.service";
import { runStatusEffect } from "./run-status.policy";
import { RunRepository } from "../run.repository";
import { RunStatusService } from "./run-status.service";
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
      runtimeType: "local",
      runtimeInstanceId: "1:token",
      conversationId: "conversation-1",
    },
    stream: new RunStream(makeRes()),
    aggregator: { build: vi.fn() } as never,
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
    findActiveByConversationId: vi
      .fn()
      .mockResolvedValue(input?.activeRun ?? null),
  };
  const runConversation = {
    setConversationRunState: vi.fn().mockResolvedValue(undefined),
  } satisfies Partial<ConversationService>;
  const registry = input?.registry ?? new LiveRunRegistry(makeConfig());
  return {
    runRepository,
    runConversation,
    registry,
    handler: new RunStatusService(
      runRepository as unknown as RunRepository,
      runConversation as unknown as ConversationService,
      registry
    ),
  };
}

describe("RunStatusService", () => {
  it("persists requires_action and saves a partial message snapshot", async () => {
    const { handler, runRepository, runConversation } = makeSubject();
    const handle = makeHandle();

    await handler.apply({
      runId: "run-1",
      payload: { status: "requires_action", pendingAction: "question" },
      effect: runStatusEffect("requires_action"),
      handle,
    });

    expect(runRepository.markRequiresAction).toHaveBeenCalledWith("run-1");
    expect(handle.saveRun).toHaveBeenCalledWith(false);
    expect(runConversation.setConversationRunState).toHaveBeenCalledWith(
      "conversation-1",
      { pendingUserAction: "question" }
    );
  });

  it("applies error terminal effects and closes the SSE response", async () => {
    const registry = new LiveRunRegistry(makeConfig());
    const unregister = vi.spyOn(registry, "unregister");
    const { handler, runRepository, runConversation } = makeSubject({
      activeRun: { id: "run-1" },
      registry,
    });
    const res = makeRes();
    const handle = makeHandle({ stream: new RunStream(res) });

    await handler.apply({
      runId: "run-1",
      payload: { status: "error", error: "boom" },
      effect: runStatusEffect("error"),
      handle,
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
  });

  it("does not overwrite conversation status when a newer run is active", async () => {
    const { handler, runConversation } = makeSubject({
      activeRun: { id: "run-2" },
    });
    const handle = makeHandle();

    await handler.apply({
      runId: "run-1",
      payload: { status: "finished" },
      effect: runStatusEffect("finished"),
      handle,
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

    await expect(
      handler.apply({
        runId: "run-1",
        payload: { status: "finished" },
        effect: runStatusEffect("finished"),
        handle,
      })
    ).rejects.toThrow("save failed");

    expect(unregister).toHaveBeenCalledWith("run-1");
  });
});
