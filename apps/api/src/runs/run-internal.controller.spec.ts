import { describe, it, expect, vi } from "vitest";
import { IS_PUBLIC_KEY } from "../auth/public.decorator";
import { RunInternalController } from "./run-internal.controller";
import { RunEnvelopeProcessor } from "./execution/run-envelope.processor";
import { RunActiveStore } from "./execution/run-active.store";
import { RuntimeConfigStore } from "../worker-host/config-store";
import { RunWorkerExecutionService } from "./execution/run-worker-execution.service";
import { RuntimeControlQueue } from "../worker-host/control-queue";

const activeHandle = {
  runtimeHandle: {
    runId: "run-1",
    runtimeType: "docker",
    runtimeInstanceId: "container-abc",
    conversationId: "conversation-1",
  },
};

function makeController(opts: {
  handle: unknown;
  runWorkerExecution: Partial<RunWorkerExecutionService>;
}) {
  const runEventProcessor: Partial<RunEnvelopeProcessor> = {
    publish: vi.fn().mockResolvedValue(undefined),
  };
  const runRegistry: Partial<RunActiveStore> = {
    get: vi.fn().mockReturnValue(opts.handle),
  };
  return new RunInternalController(
    runEventProcessor as RunEnvelopeProcessor,
    {} as RuntimeConfigStore,
    runRegistry as RunActiveStore,
    opts.runWorkerExecution as RunWorkerExecutionService,
    {} as RuntimeControlQueue
  );
}

describe("RunInternalController", () => {
  it("is marked @Public() so the global JwtAuthGuard does not block worker callbacks (auth is handled by RuntimeInternalAuthGuard)", () => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, RunInternalController)).toBe(
      true
    );
  });

  describe("postEvent()", () => {
    it("cleans up via RunWorkerExecutionService on terminal status", async () => {
      const runWorkerExecution: Partial<RunWorkerExecutionService> = {
        cleanup: vi.fn(),
      };
      const controller = makeController({
        handle: activeHandle,
        runWorkerExecution,
      });

      await controller.postEvent("run-1", {
        runId: "run-1",
        seq: 1,
        type: "run.status",
        payload: { status: "finished" },
        ts: new Date().toISOString(),
      });

      expect(runWorkerExecution.cleanup).toHaveBeenCalledWith("run-1");
    });

    it("does not call cleanup for non-terminal run.status", async () => {
      const runWorkerExecution: Partial<RunWorkerExecutionService> = {
        cleanup: vi.fn(),
      };
      const controller = makeController({
        handle: activeHandle,
        runWorkerExecution,
      });

      await controller.postEvent("run-1", {
        runId: "run-1",
        seq: 1,
        type: "run.status",
        payload: { status: "running" },
        ts: new Date().toISOString(),
      });

      expect(runWorkerExecution.cleanup).not.toHaveBeenCalled();
    });

    it("feeds the heartbeat watchdog via RunWorkerExecutionService on heartbeat events", async () => {
      const runWorkerExecution: Partial<RunWorkerExecutionService> = {
        heartbeat: vi.fn(),
      };
      const controller = makeController({
        handle: activeHandle,
        runWorkerExecution,
      });

      await controller.postEvent("run-1", {
        runId: "run-1",
        seq: 1,
        type: "heartbeat",
        payload: { at: new Date().toISOString() },
        ts: new Date().toISOString(),
      });

      expect(runWorkerExecution.heartbeat).toHaveBeenCalledWith("run-1");
    });

    it("does not feed heartbeat when no run handle is registered", async () => {
      const runWorkerExecution: Partial<RunWorkerExecutionService> = {
        heartbeat: vi.fn(),
      };
      const controller = makeController({
        handle: undefined,
        runWorkerExecution,
      });

      await controller.postEvent("run-1", {
        runId: "run-1",
        seq: 1,
        type: "heartbeat",
        payload: { at: new Date().toISOString() },
        ts: new Date().toISOString(),
      });

      expect(runWorkerExecution.heartbeat).not.toHaveBeenCalled();
    });
  });
});
